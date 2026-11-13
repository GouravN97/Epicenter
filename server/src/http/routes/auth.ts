import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { LoginBodySchema, type LoginResponse } from '@epicenter/shared';
import { config } from '../../config';
import { UserModel, toUserDTO } from '../../db/models';
import { signToken } from '../../lib/jwt';
import { HttpError } from '../errors';
import { auth, currentUser } from '../middleware/auth';

// Compared against when the email is unknown, so a miss costs the same time as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many login attempts, try again in a minute')),
});

export const authRouter = Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = LoginBodySchema.parse(req.body);
  const user = await UserModel.findOne({ email });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

  const dto = toUserDTO(user);
  const token = signToken({ sub: dto.id, role: dto.role, teams: dto.teams, name: dto.name }, config.jwtSecret);
  const body: LoginResponse = { token, user: dto };
  res.json(body);
});

authRouter.get('/me', auth, async (req, res) => {
  const user = await UserModel.findById(currentUser(req).sub);
  if (!user) throw new HttpError(401, 'unknown_user', 'User no longer exists');
  res.json(toUserDTO(user));
});
