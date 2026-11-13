import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { SERVICES, buildFleet } from '@epicenter/shared';
import { config } from '../config';
import type { PipelineCore } from '../pipeline/ingest';
import { errorHandler, notFound } from './errors';
import { authRouter } from './routes/auth';
import { ingestRouter } from './routes/ingest';
import { topologyRouter } from './routes/topology';
import { historyRouter } from './routes/history';
import { alertsRouter } from './routes/alerts';
import type { Detector } from '../pipeline/detector';
import type { ChaosService } from '../chaos/chaosService';
import { chaosRouter } from './routes/chaos';

export interface AppDeps {
  pipeline: PipelineCore;
  detector: Detector;
  chaos: ChaosService;
}

export function createApp({ pipeline, detector, chaos }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Render's proxy in production: needed so the login rate limit keys on the client IP.
  if (config.isProd) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.clientOrigin, credentials: false, maxAge: 600 }));

  const api = express.Router();
  // /ingest checks the agent key first, then parses up to 256 kB. Everything else is small JSON.
  api.use('/ingest', ingestRouter(pipeline));
  api.use(express.json({ limit: '32kb' }));

  api.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now(), services: SERVICES.length, nodes: buildFleet().length });
  });
  api.use('/auth', authRouter);
  api.use('/topology', topologyRouter(pipeline.registry));
  api.use('/alerts', alertsRouter(detector));
  api.use('/chaos', chaosRouter(chaos));
  api.use(historyRouter(pipeline.registry));

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
