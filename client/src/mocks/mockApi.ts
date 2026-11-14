// Mock REST layer for mock mode: the plan's §6 routes that the client uses, answered by the mock backend.
import type { ChaosStartBody, LoginBody, LoginResponse, UserDTO } from '@epicenter/shared';
import { HttpError } from '../lib/api';
import { getMockBackend, MockHttpError } from './mockBackend';

export const SEED_USERS: UserDTO[] = [
  { id: 'u-admin', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] },
  { id: 'u-sre', email: 'sre@epicenter.dev', name: 'SRE On-call', role: 'sre', teams: ['platform', 'commerce', 'payments', 'data'] },
  { id: 'u-payments', email: 'payments@epicenter.dev', name: 'Payments Viewer', role: 'viewer', teams: ['payments'] },
];

const TOKEN_PREFIX = 'mock.';

export function userFromToken(token: string | null): UserDTO {
  const email = token?.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : '';
  const user = SEED_USERS.find((u) => u.email === email);
  if (!user) throw new HttpError(401, 'unauthorized', 'Invalid or expired token');
  return user;
}

type Query = Record<string, string | number | boolean | undefined | null>;
const num = (v: Query[string]): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
const str = (v: Query[string]): string | undefined => (v === undefined || v === null ? undefined : String(v));

function route(method: string, path: string, body: unknown, query: Query, token: string | null): unknown {
  if (method === 'POST' && path === '/auth/login') {
    const { email, password } = (body ?? {}) as Partial<LoginBody>;
    const user = SEED_USERS.find((u) => u.email === email?.trim().toLowerCase());
    // Mock mode accepts any non-empty password for a seed user.
    if (!user || !password) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    return { token: TOKEN_PREFIX + user.email, user } satisfies LoginResponse;
  }

  const user = userFromToken(token);
  if (method === 'GET' && path === '/auth/me') return user;

  const be = getMockBackend();
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const from = num(query.from) ?? Date.now() - 15 * 60_000;
  const to = num(query.to) ?? Date.now();

  if (method === 'GET') {
    if (path === '/topology') return be.topology(user);
    if (seg[0] === 'metrics' && seg[1] === 'node' && seg[2]) return be.nodeSeries(user, seg[2], from, to, str(query.res));
    if (seg[0] === 'metrics' && seg[1] === 'service' && seg[2]) return be.serviceSeries(user, seg[2], from, to, str(query.res));
    if (path === '/alerts') return be.alerts(user, { state: str(query.state), limit: num(query.limit), before: num(query.before) });
    if (path === '/incidents') return be.incidentList(user);
    if (seg[0] === 'incidents' && seg[1] && seg.length === 2) return be.incidentDetail(user, seg[1]);
    if (path === '/meta/stats') return be.frame?.stats ?? null;
    if (path === '/chaos/scenarios') return be.chaosScenarios(user);
    if (path === '/chaos/runs') return be.chaosRuns(user);
    if (path === '/replay') {
      const services = (str(query.services) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      return be.replay(user, from, to, services);
    }
  }
  if (method === 'POST' && path === '/chaos/start') return be.chaosStart(user, (body ?? {}) as Partial<ChaosStartBody>);
  if (method === 'POST' && path === '/chaos/stop') return be.chaosStop(user, (body as { runId?: string } | undefined)?.runId);
  if (method === 'POST' && seg[0] === 'incidents' && seg[1] && seg[2] === 'notes') {
    return be.addNote(user, seg[1], String((body as { text?: unknown } | null)?.text ?? ''));
  }
  if (method === 'POST' && seg[0] === 'alerts' && seg[1] && seg[2] === 'ack') return be.ack(seg[1], user);

  throw new HttpError(404, 'not_found', `No mock for ${method} ${path}`);
}

export async function mockRequest(method: string, path: string, body: unknown, query: Query | undefined, token: string | null): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120)); // so loading states are visible
  try {
    return route(method, path, body, query ?? {}, token);
  } catch (err) {
    if (err instanceof MockHttpError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
}
