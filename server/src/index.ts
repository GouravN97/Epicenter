import http from 'node:http';
import { config, requireEnv } from './config';
import { connectDb, disconnectDb, ensureIndexes } from './db/connect';
import { NodeModel } from './db/models';
import { startNodeSync } from './db/nodeSync';
import { createApp } from './http/app';
import { createPipeline } from './pipeline';
import { snapshotStats } from './pipeline/pipelineStats';
import { createRealtime } from './realtime/io';

// Writer (A6) and detector (A7) are wired in later tasks.
async function main(): Promise<void> {
  requireEnv('MONGODB_URI', 'JWT_SECRET');
  await connectDb();
  await ensureIndexes();
  const known = await NodeModel.find({}, { nodeId: 1 }).sort({ firstSeen: 1, _id: 1 }).lean();
  console.log(`[server] connected to MongoDB (${known.length} nodes registered)`);

  const pipeline = createPipeline(known.map((n) => n.nodeId));
  pipeline.start();
  const stopNodeSync = startNodeSync(pipeline.registry, pipeline.state);

  if (process.env.DEBUG_PIPELINE) {
    let points = 0;
    let corrections = 0;
    pipeline.aggregator.on({ point: (_p, c) => (c ? corrections++ : points++) });
    setInterval(() => {
      const c = pipeline.counters.prev;
      console.log(
        `[pipeline] accepted ${c.accepted}/s dup ${c.duplicate} ooo ${c.outOfOrder} late ${c.lateCorrected} ` +
          `rejected ${c.rejected} stale ${c.stale} · points ${points}/5s corrections ${corrections} · open ${pipeline.aggregator.second.openCount()}`,
      );
      points = corrections = 0;
    }, 5_000).unref();
  }

  const server = http.createServer(createApp(pipeline));
  const rt = createRealtime(server, pipeline);
  rt.broadcaster.stats = () => {
    const d = rt.dashStats();
    return snapshotStats({
      counters: pipeline.counters.prev,
      bucketsOpen: pipeline.aggregator.second.openCount(),
      socketsDash: d.sockets,
      rooms: d.rooms,
      emitsPerSec: rt.broadcaster.emitsPerSec,
      clientE2eP95: d.clientE2eP95,
    });
  };
  rt.broadcaster.start();

  server.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[server] ${sig} received, shutting down`);
    pipeline.stop();
    stopNodeSync();
    void rt.close();
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
