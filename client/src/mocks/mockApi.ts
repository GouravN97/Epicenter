// Mock REST layer for mock mode. Covers the auth routes (plan §6.3); later tasks add more routes here.
import type { LoginBody, LoginResponse, UserDTO } from '@epicenter/shared';
import { HttpError } from '../lib/api';

export const SEED_USERS: UserDTO[] = [
  { id: 'u-admin', email: 'admin@epicenter.dev', name: 'Admin', role: 'admin', teams: ['platform', 'commerce', 'payments', 'data'] },
  { id: 'u-sre', email: 'sre@epicenter.dev', name: 'SRE On-call', role: 'sre', teams: ['platform', 'commerce', 'payments', 'data'] },
  { id: 'u-payments', email: 'payments@epicenter.dev', name: 'Payments Viewer', role: 'viewer', teams: ['payments'] },
];

const TOKEN_PREFIX = 'mock.';

function userFromToken(token: string | null): UserDTO {
  const email = token?.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : '';
  const user = SEED_USERS.find((u) => u.email === email);
  if (!user) throw new HttpError(401, 'unauthorized', 'Invalid or expired token');
  return user;
}

export async function mockRequest(method: string, path: string, body: unknown, token: string | null): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 250)); // so loading states are visible

  if (method === 'POST' && path === '/auth/login') {
    const { email, password } = (body ?? {}) as Partial<LoginBody>;
    const user = SEED_USERS.find((u) => u.email === email?.trim().toLowerCase());
    // Mock mode accepts any non-empty password for a seed user.
    if (!user || !password) throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
    return { token: TOKEN_PREFIX + user.email, user } satisfies LoginResponse;
  }
  if (method === 'GET' && path === '/auth/me') return userFromToken(token);

  throw new HttpError(404, 'not_found', `No mock for ${method} ${path}`);
}
