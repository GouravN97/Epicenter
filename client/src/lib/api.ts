// REST client for /api/v1 (plan §6). Errors arrive as `{ error: { code, message } }`.
import type { ApiError } from './contract';
import { API_URL, USE_MOCK } from './env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// The auth store registers these, so this module does not import the store (no import cycle).
let getToken: () => string | null = () => null;
let onUnauthorized: () => void = () => {};
export function bindAuth(hooks: { getToken: () => string | null; onUnauthorized: () => void }): void {
  getToken = hooks.getToken;
  onUnauthorized = hooks.onUnauthorized;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${API_URL}/api/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function request<T>(method: string, path: string, opts: { body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  const token = getToken();
  try {
    if (USE_MOCK) {
      const { mockRequest } = await import('../mocks/mockApi');
      return (await mockRequest(method, path, opts.body, token)) as T;
    }

    let res: Response;
    try {
      res = await fetch(buildUrl(path, opts.query), {
        method,
        signal: opts.signal,
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new HttpError(0, 'network', 'Cannot reach the Epicenter API');
    }

    const data: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = (data as ApiError | undefined)?.error;
      throw new HttpError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  } catch (err) {
    // A rejected token on any route other than login means the session is over.
    if (err instanceof HttpError && err.status === 401 && path !== '/auth/login') onUnauthorized();
    throw err;
  }
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
};
