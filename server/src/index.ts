import http from 'node:http';
import { config, requireEnv } from './config';
import { connectDb, disconnectDb, ensureIndexes } from './db/connect';
import { createApp } from './http/app';

// Socket.IO (A5) and the pipeline (A4+) are wired in later tasks.
async function main(): Promise<void> {
  requireEnv('MONGODB_URI', 'JWT_SECRET');
  await connectDb();
  await ensureIndexes();
  console.log('[server] connected to MongoDB');

  const server = http.createServer(createApp());
  server.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[server] ${sig} received, shutting down`);
    server.close(() => void disconnectDb().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
