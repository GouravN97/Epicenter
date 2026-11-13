import type { RequestHandler } from 'express';
import type { AuthClaims, Role } from '@epicenter/shared';
import { config } from '../../config';
import { verifyToken } from '../../lib/jwt';
import { HttpError } from '../errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `auth`. */
      user?: AuthClaims;
    }
  }
}

/** Requires `Authorization: Bearer <jwt>`. Sets `req.user` from the verified claims. */
export const auth: RequestHandler = (req, _res, next) => {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return next(new HttpError(401, 'unauthenticated', 'Missing bearer token'));
  try {
    req.user = verifyToken(token, config.jwtSecret);
    next();
  } catch {
    next(new HttpError(401, 'invalid_token', 'Token is invalid or expired'));
  }
};

/** Use after `auth`. 403 unless the user has one of the roles. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Not signed in'));
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, 'forbidden', `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };

/** The signed-in user, for handlers mounted behind `auth`. */
export function currentUser(req: { user?: AuthClaims }): AuthClaims {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Not signed in');
  return req.user;
}
