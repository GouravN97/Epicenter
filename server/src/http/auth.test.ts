import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { signToken, verifyToken } from '../lib/jwt';
import { HttpError, toApiError } from './errors';

const SECRET = 'test-secret-not-used-anywhere-else';
const claims = { sub: '64b000000000000000000001', role: 'viewer', teams: ['payments'], name: 'P' } as const;

describe('jwt', () => {
  it('round-trips claims', () => {
    const t = signToken({ ...claims, teams: [...claims.teams] }, SECRET);
    expect(verifyToken(t, SECRET)).toEqual({ ...claims, teams: ['payments'] });
  });

  it('rejects a wrong secret, an expired token and alg=none', () => {
    const t = signToken({ ...claims, teams: [...claims.teams] }, SECRET);
    expect(() => verifyToken(t, 'other')).toThrow();
    const expired = jwt.sign({ role: 'admin', teams: [] }, SECRET, { subject: 'x', expiresIn: -10 });
    expect(() => verifyToken(expired, SECRET)).toThrow();
    const none = jwt.sign({ role: 'admin', teams: [] }, '', { algorithm: 'none', subject: 'x' });
    expect(() => verifyToken(none, SECRET)).toThrow();
  });

  it('rejects unknown roles and teams', () => {
    const badRole = jwt.sign({ role: 'root', teams: [] }, SECRET, { subject: 'x' });
    const badTeam = jwt.sign({ role: 'viewer', teams: ['hr'] }, SECRET, { subject: 'x' });
    expect(() => verifyToken(badRole, SECRET)).toThrow();
    expect(() => verifyToken(badTeam, SECRET)).toThrow();
  });
});

describe('toApiError', () => {
  it('maps HttpError', () => {
    expect(toApiError(new HttpError(403, 'forbidden', 'no'))).toEqual({
      status: 403,
      body: { error: { code: 'forbidden', message: 'no', issues: undefined } },
    });
  });

  it('maps zod errors to 400 with at most 5 issues', () => {
    const r = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string() }).safeParse({});
    const { status, body } = toApiError(r.error);
    expect(status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.issues).toHaveLength(5);
  });

  it('maps body-parser errors and hides internals', () => {
    expect(toApiError({ type: 'entity.too.large', status: 413 }).status).toBe(413);
    expect(toApiError({ type: 'entity.parse.failed', status: 400 }).status).toBe(400);
    const { status, body } = toApiError(new Error('secret db detail'));
    expect(status).toBe(500);
    expect(body.error.message).not.toContain('secret');
  });
});
