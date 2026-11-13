import jwt from 'jsonwebtoken';
import { AUTH_TOKEN_TTL, ROLES, TEAMS, type AuthClaims } from '@epicenter/shared';

const ALG = 'HS256' as const;

export function signToken(claims: AuthClaims, secret: string): string {
  return jwt.sign({ role: claims.role, teams: claims.teams, name: claims.name }, secret, {
    algorithm: ALG,
    subject: claims.sub,
    expiresIn: AUTH_TOKEN_TTL,
  });
}

/** Verifies signature, algorithm and expiry, and checks the claim shapes. Throws on anything invalid. */
export function verifyToken(token: string, secret: string): AuthClaims {
  const p = jwt.verify(token, secret, { algorithms: [ALG] });
  if (typeof p === 'string' || !p.sub) throw new Error('malformed token');
  const { role, teams, name } = p as Record<string, unknown>;
  if (!ROLES.includes(role as never)) throw new Error('malformed token');
  if (!Array.isArray(teams) || !teams.every((t) => TEAMS.includes(t))) throw new Error('malformed token');
  return { sub: p.sub, role: role as AuthClaims['role'], teams: teams as AuthClaims['teams'], name: String(name ?? '') };
}
