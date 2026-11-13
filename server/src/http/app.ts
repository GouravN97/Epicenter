import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { SERVICES, buildFleet } from '@epicenter/shared';
import { config } from '../config';
import { errorHandler, notFound } from './errors';
import { authRouter } from './routes/auth';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render's proxy in production: needed so the login rate limit keys on the client IP.
  if (config.isProd) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: false, maxAge: 600 }));

  const api = express.Router();
  // /ingest (A4) mounts its own 256 kB parser before this one; everything else is small JSON.
  api.use(express.json({ limit: '32kb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), services: SERVICES.length, nodes: buildFleet().length });
  });
  api.use('/auth', authRouter);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
