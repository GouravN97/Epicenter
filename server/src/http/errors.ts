import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@epicenter/shared';

/** Throw from any handler; the error middleware turns it into `{ error: { code, message } }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
  }
}

const MAX_ISSUES = 5;

/** Pure mapping from any thrown value to a status + body. Unknown errors become a generic 500. */
export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, issues: err.issues } } };
  }
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { status: 400, body: { error: { code: 'validation_failed', message: 'Request is invalid', issues } } };
  }
  // body-parser errors carry `type` and `status`.
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    return { status: 413, body: { error: { code: 'payload_too_large', message: 'Request body is too large' } } };
  }
  if (e?.type === 'entity.parse.failed') {
    return { status: 400, body: { error: { code: 'invalid_json', message: 'Request body is not valid JSON' } } };
  }
  if (typeof e?.status === 'number' && e.status >= 400 && e.status < 500) {
    return { status: e.status, body: { error: { code: 'bad_request', message: 'Bad request' } } };
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } } };
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const { status, body } = toApiError(err);
  if (status >= 500) console.error(`[http] ${req.method} ${req.path}`, err);
  if (res.headersSent) return;
  res.status(status).json(body);
};
