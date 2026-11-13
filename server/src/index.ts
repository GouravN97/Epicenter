import http from 'node:http';
import express from 'express';
import { SERVICES, buildFleet } from '@epicenter/shared';
import { config } from './config';

// A1 walking-empty server. Mongo (A2), Socket.IO (A5) and the pipeline (A4+) are wired in later tasks.
const app = express();
app.disable('x-powered-by');

app.get('/api/v1/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), services: SERVICES.length, nodes: buildFleet().length });
});

const server = http.createServer(app);
server.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
});

const shutdown = (sig: string) => {
  console.log(`[server] ${sig} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
