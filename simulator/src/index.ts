// Simulator entry. CLI: npm run sim -- --url http://localhost:4000 --hz 2 [--dry-run] [--verbose]
// Also exports startSimulator() so the server can embed it (EMBEDDED_SIM=true, task A12).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REGIONS, SIM_DEFAULT_HZ, agentIdForRegion, buildFleet, type IngestBatch } from '@epicenter/shared';
import { Agent, httpTransport, type Transport } from './agent';
import { World, serviceSummary, type Sample } from './world';

export interface SimulatorOptions {
  url: string;
  key: string;
  hz?: number;
  /** Do not POST; every batch is accepted locally. */
  dryRun?: boolean;
  /** Log every batch. */
  verbose?: boolean;
  /** Status line interval; 0 disables. */
  statusEveryMs?: number;
  seed?: number;
  log?: (line: string) => void;
}

export interface Simulator {
  world: World;
  agents: Agent[];
  stop(): void;
}

export function startSimulator(opts: SimulatorOptions): Simulator {
  const hz = opts.hz ?? SIM_DEFAULT_HZ;
  if (!(hz > 0 && hz <= 50)) throw new Error(`--hz must be in (0, 50], got ${hz}`);
  const log = opts.log ?? ((l: string) => console.log(l));

  const fleet = buildFleet();
  const world = new World({ seed: opts.seed, fleet });
  const send: Transport = opts.dryRun
    ? async (_b: IngestBatch) => ({ status: 202 })
    : httpTransport(opts.url, opts.key);

  const agents = REGIONS.map(
    (r) =>
      new Agent({
        agentId: agentIdForRegion(r.id),
        nodeIds: fleet.filter((n) => n.region === r.id).map((n) => n.nodeId),
        send,
        onBatch: opts.verbose
          ? (b) => log(`[sim] ${b.agentId.padEnd(15)} batch ${String(b.events).padStart(3)} events  seq ${b.seqFrom}..${b.seqTo}  → ${b.status}`)
          : undefined,
      }),
  );
  const agentFor = new Map<string, Agent>();
  for (const n of fleet) agentFor.set(n.nodeId, agents.find((a) => a.owns(n.nodeId))!);

  let last = Date.now();
  let lastSamples: Sample[] = [];
  const tick = setInterval(() => {
    const now = Date.now();
    lastSamples = world.step(now, (now - last) / 1000);
    last = now;
    for (const s of lastSamples) agentFor.get(s.nodeId)!.record(s.nodeId, now, s.m);
  }, 1000 / hz);
  for (const a of agents) a.start();

  log(`[sim] ${fleet.length} nodes, ${agents.length} agents, ${hz} Hz → ${opts.dryRun ? 'dry run (no HTTP)' : opts.url}`);

  let statusTimer: NodeJS.Timeout | null = null;
  const every = opts.statusEveryMs ?? 5_000;
  if (every > 0) {
    let prevSent = 0;
    let prevBatches = 0;
    statusTimer = setInterval(() => {
      const sent = agents.reduce((a, x) => a + x.stats.sent, 0);
      const batches = agents.reduce((a, x) => a + x.stats.batches, 0);
      const status: Record<string, number> = {};
      for (const a of agents) for (const [k, v] of Object.entries(a.stats.status)) status[k] = (status[k] ?? 0) + v;
      const buffered = agents.reduce((a, x) => a + x.stats.buffer, 0);
      const dropped = agents.reduce((a, x) => a + x.stats.dropped, 0);
      const err = agents.map((a) => a.stats.lastError).find(Boolean);
      const secs = every / 1000;
      log(
        `[sim] ${((sent - prevSent) / secs).toFixed(1)} ev/s · ${((batches - prevBatches) / secs).toFixed(1)} batch/s · ` +
          `status ${JSON.stringify(status)} · buffered ${buffered} · dropped ${dropped}${err ? ` · last error: ${err}` : ''}`,
      );
      prevSent = sent;
      prevBatches = batches;
      if (opts.verbose) {
        for (const [svc, m] of Object.entries(serviceSummary(lastSamples))) {
          log(
            `      ${svc.padEnd(13)} rps ${m.rps.toFixed(0).padStart(5)}  cpu ${m.cpu.toFixed(1).padStart(5)}  mem ${m.mem.toFixed(1).padStart(5)}  ` +
              `lat ${m.lat.toFixed(1).padStart(6)}ms  err ${m.err.toFixed(2).padStart(5)}%  in ${m.netIn.toFixed(0).padStart(5)}kB/s`,
          );
        }
      }
    }, every);
  }

  return {
    world,
    agents,
    stop() {
      clearInterval(tick);
      if (statusTimer) clearInterval(statusTimer);
      for (const a of agents) a.stop();
    },
  };
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.SIM_URL || `http://localhost:${process.env.PORT || 4000}` },
      hz: { type: 'string', default: String(SIM_DEFAULT_HZ) },
      key: { type: 'string', default: process.env.SIM_KEY ?? '' },
      seed: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (!values.key && !values['dry-run']) {
    console.error('[sim] SIM_KEY is not set (put it in .env or pass --key). Use --dry-run to run without a server.');
    process.exit(1);
  }
  const sim = startSimulator({
    url: values.url,
    key: values.key,
    hz: Number(values.hz),
    dryRun: values['dry-run'],
    verbose: values.verbose,
    seed: values.seed ? Number(values.seed) : undefined,
  });
  const shutdown = () => {
    sim.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
