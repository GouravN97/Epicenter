// Stress test (plan §10, task A11).
//
//   npm run stress -- --profile baseline|heavy|high|max|all
//   npm run stress -- --nodes 500 --hz 5 --clients 200 --duration 60      (custom)
//
// Registers its own ingest agents in MongoDB, sends `nodes × hz` events/s through the real POST /ingest using
// the simulator's Agent class (batching, 429 back-off, thinning), opens `clients` Socket.IO dashboard
// connections, polls GET /meta/stats every second, and writes the results to docs/BENCHMARKS.md.
//
// Run it against a LOCAL server on a scratch database: stress nodes are registered permanently and would
// appear on a real dashboard. It refuses remote URLs and Atlas connection strings unless --allow-remote.
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { io, type Socket } from 'socket.io-client';
import { NS_DASH, REGIONS, SERVICES, room, type DashC2S, type DashS2C, type LoginResponse, type MetricValues, type PipelineStats } from '@epicenter/shared';
import { Agent, httpTransport } from '@epicenter/simulator';
import {
  NOTES_STUB,
  PROFILES,
  renderHeader,
  renderSection,
  summarize,
  upsertSection,
  type ClientSample,
  type MachineInfo,
  type ProfileName,
  type ProfileSpec,
  type RunSummary,
  type Tick,
} from './report';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

/** Events per second one agent is given; the simulator's Agent sends ≤ 500 events every 500 ms. */
const EPS_PER_AGENT = 700;
const NODE_ROOMS_PER_CLIENT = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[stress] ${s}`);

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.STRESS_URL || `http://localhost:${process.env.PORT || 4000}` },
    mongo: { type: 'string', default: process.env.MONGODB_URI ?? '' },
    profile: { type: 'string', default: 'custom' },
    nodes: { type: 'string' },
    hz: { type: 'string' },
    clients: { type: 'string' },
    duration: { type: 'string' },
    recover: { type: 'string' },
    'recover-hz': { type: 'string' },
    warmup: { type: 'string', default: '15' },
    pause: { type: 'string', default: '20' },
    out: { type: 'string', default: path.join(ROOT, 'docs/BENCHMARKS.md') },
    'no-write': { type: 'boolean', default: false },
    'allow-remote': { type: 'boolean', default: false },
    email: { type: 'string', default: 'admin@epicenter.dev' },
    password: { type: 'string', default: process.env.SEED_ADMIN_PASSWORD ?? '' },
  },
});

const url = args.url.replace(/\/+$/, '');
const api = `${url}/api/v1`;

// ---------------------------------------------------------------------------------------------- setup

function guardRemote(): void {
  if (args['allow-remote']) return;
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`refusing to stress ${host}: stress nodes are registered permanently. Use a local server, or pass --allow-remote.`);
  }
  if (args.mongo.startsWith('mongodb+srv:') || !/127\.0\.0\.1|localhost/.test(args.mongo)) {
    throw new Error('refusing a non-local MONGODB_URI (the stress agents are written there). Point --mongo at the local scratch database, or pass --allow-remote.');
  }
}

/** Registers `count` stress agents sharing one fresh key, owning every node id (prefix ''); disables older ones. */
async function registerAgents(count: number, eps: number): Promise<{ key: string; ids: string[] }> {
  const key = randomBytes(24).toString('hex');
  const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
  const ids = Array.from({ length: count }, (_, i) => `stress-${String(i + 1).padStart(2, '0')}`);
  const agents = mongoose.connection.collection('agents');
  // Generous budget: the stress test measures the server, not the per-agent token bucket.
  const ratePerSec = Math.ceil((eps * 2) / count) + 100;
  await agents.bulkWrite(
    ids.map((agentId) => ({
      updateOne: {
        filter: { agentId },
        update: { $set: { keyHash, name: `Stress ${agentId}`, nodePrefix: '', ratePerSec, burst: ratePerSec * 2, enabled: true, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    })),
  );
  await agents.updateMany({ agentId: { $regex: /^stress-/, $nin: ids } }, { $set: { enabled: false } });
  return { key, ids };
}

async function disableAgents(): Promise<void> {
  await mongoose.connection.collection('agents').updateMany({ agentId: { $regex: /^stress-/ } }, { $set: { enabled: false } });
}

async function login(): Promise<string> {
  if (!args.password) throw new Error('no admin password: set SEED_ADMIN_PASSWORD in .env or pass --password');
  const res = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: args.email, password: args.password }) });
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`);
  return ((await res.json()) as LoginResponse).token;
}

async function machine(): Promise<MachineInfo> {
  let mongo = 'unknown';
  try {
    mongo = String((await mongoose.connection.db!.admin().serverInfo()).version);
  } catch {
    /* not allowed on this deployment */
  }
  return {
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.cpus().length,
    memGb: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    mongo,
  };
}

/** Canonical node ids beyond the seeded fleet (index 101+), spread over every service and AZ. */
function stressNodeIds(n: number): string[] {
  const azs = REGIONS.flatMap((r) => r.azs.map((a) => `${r.id}${a}`));
  return Array.from({ length: n }, (_, i) => `${azs[Math.floor(i / SERVICES.length) % azs.length]}.${SERVICES[i % SERVICES.length]!.id}.${101 + i}`);
}

// ---------------------------------------------------------------------------------------------- load

/** Calm, plausible metrics with a little noise, so the detector stays quiet and only throughput is tested. */
function makeGenerator(nodeIds: string[]): (id: string) => MetricValues {
  const base = new Map(
    nodeIds.map((id, i) => {
      const svc = SERVICES[i % SERVICES.length]!;
      return [id, { cpu: 25 + (i % 20), mem: 45 + (i % 15), lat: svc.baseLatMs * 2 }];
    }),
  );
  const j = (x: number, by: number) => x + (Math.random() - 0.5) * by;
  return (id) => {
    const b = base.get(id)!;
    return { cpu: j(b.cpu, 2), mem: j(b.mem, 0.5), disk: 40, netIn: j(200, 20), netOut: j(300, 20), lat: j(b.lat, b.lat * 0.1), err: 0.2, rps: j(50, 5) };
  };
}

class Load {
  readonly agents: Agent[];
  private timer: NodeJS.Timeout | null = null;
  private readonly sample: (id: string) => MetricValues;
  private readonly owner = new Map<string, Agent>();

  constructor(
    readonly nodeIds: string[],
    agentIds: string[],
    key: string,
  ) {
    const groups = agentIds.map(() => [] as string[]);
    nodeIds.forEach((id, i) => groups[i % groups.length]!.push(id));
    this.agents = agentIds.map((agentId, i) => new Agent({ agentId, nodeIds: groups[i]!, send: httpTransport(url, key, 10_000) }));
    this.agents.forEach((a, i) => groups[i]!.forEach((id) => this.owner.set(id, a)));
    this.sample = makeGenerator(nodeIds);
  }

  setHz(hz: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (hz <= 0) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const id of this.nodeIds) this.owner.get(id)!.record(id, now, this.sample(id));
    }, 1000 / hz);
  }

  start(hz: number): void {
    for (const a of this.agents) a.start();
    this.setHz(hz);
  }

  stop(): void {
    this.setHz(0);
    for (const a of this.agents) a.stop();
  }

  totals() {
    let sent = 0, b429 = 0, batches = 0, dropped = 0, thinned = 0;
    for (const a of this.agents) {
      sent += a.stats.sent;
      b429 += a.stats.status['429'] ?? 0;
      batches += a.stats.batches;
      dropped += a.stats.dropped;
      thinned += a.stats.thinned;
    }
    return { sent, b429, batches, dropped, thinned };
  }
}

// ---------------------------------------------------------------------------------------------- clients

type Dash = Socket<DashS2C, DashC2S>;

class Client {
  readonly sample: ClientSample = { deliveryMs: [], e2eMs: [], messages: 0, bytes: 0, connected: false, seconds: 0 };
  measuring = false;
  private readonly socket: Dash;

  constructor(token: string, nodeRooms: string[]) {
    this.socket = io(url + NS_DASH, { transports: ['websocket'], auth: { token }, forceNew: true, reconnectionDelay: 1000 });
    this.socket.on('connect', () => {
      this.sample.connected = true;
      this.socket.io.engine.on('data', (d: string | ArrayBuffer) => {
        if (this.measuring) this.sample.bytes += typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength;
      });
      this.subscribe([room.fleetAll, room.meta, ...nodeRooms], 10);
    });
    this.socket.onAny(() => {
      if (this.measuring) this.sample.messages++;
    });
    this.socket.on('meta:pt', (s) => {
      if (this.measuring) this.sample.deliveryMs.push(Date.now() - s.ts);
    });
    this.socket.on('node:pt', (p) => {
      if (this.measuring) this.sample.e2eMs.push(Date.now() - p[1]);
    });
  }

  /** A node room is refused until that node's first event registers it, so refused rooms are retried. */
  private subscribe(rooms: string[], triesLeft: number): void {
    this.socket.emit('sub', { rooms }, (ack) => {
      if (ack.denied.length && triesLeft > 0) setTimeout(() => this.subscribe(ack.denied, triesLeft - 1), 1000);
    });
  }

  close(): void {
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------------------------- one run

async function pollStats(token: string): Promise<PipelineStats | null> {
  try {
    const res = await fetch(`${api}/meta/stats`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(900) });
    return res.ok ? ((await res.json()) as PipelineStats) : null;
  } catch {
    return null;
  }
}

async function runProfile(profile: ProfileName, spec: ProfileSpec, token: string, command: string): Promise<RunSummary> {
  const eps = spec.nodes * spec.hz;
  const nAgents = Math.max(1, Math.ceil(eps / EPS_PER_AGENT));
  const { key, ids } = await registerAgents(nAgents, eps);
  const nodeIds = stressNodeIds(spec.nodes);
  log(`${profile}: ${spec.nodes} nodes × ${spec.hz} Hz = ${eps} ev/s via ${nAgents} agents, ${spec.clients} clients`);

  const load = new Load(nodeIds, ids, key);
  const warmup = Number(args.warmup);
  load.start(spec.hz);

  // Clients connect during the warm-up, a few at a time, each with three random node rooms.
  const clients: Client[] = [];
  for (let i = 0; i < spec.clients; i++) {
    const rooms = Array.from({ length: NODE_ROOMS_PER_CLIENT }, () => room.node(nodeIds[Math.floor(Math.random() * nodeIds.length)]!));
    clients.push(new Client(token, rooms));
    if (i % 20 === 19) await sleep(100);
  }

  const ticks: Tick[] = [];
  let prev = load.totals();
  const total = warmup + spec.durationSec + spec.recoverSec;
  const t0 = Date.now() + warmup * 1000; // load phase starts here
  for (let s = 0; s < total; s++) {
    const tickStart = Date.now();
    const t = Math.round((tickStart - t0) / 1000);
    const phase: Tick['phase'] = t < 0 ? 'warmup' : t < spec.durationSec ? 'load' : 'recover';
    if (phase === 'load' && !clients[0]?.measuring) for (const c of clients) c.measuring = true;
    if (phase === 'recover' && clients[0]?.measuring) {
      for (const c of clients) c.measuring = false;
      load.setHz(spec.recoverHz);
    }
    for (const c of clients) if (c.measuring) c.sample.seconds++;
    const stats = await pollStats(token);
    const cur = load.totals();
    ticks.push({ t, phase, stats, sent: cur.sent - prev.sent, batches429: cur.b429 - prev.b429 });
    prev = cur;
    if (phase !== 'warmup' && t % 10 === 0) {
      log(`  t=${t}s ${phase} accepted ${stats?.accepted ?? '?'}/s · 429s ${stats?.shed429 ?? '?'} · lag p99 ${stats?.loopLagP99 ?? '?'} ms · rss ${stats?.rssMb ?? '?'} MB${stats?.shedding ? ' · SHEDDING' : ''}`);
    }
    await sleep(Math.max(0, 1000 - (Date.now() - tickStart)));
  }

  load.stop();
  for (const c of clients) c.close();
  const t = load.totals();
  return summarize({
    profile,
    spec,
    command,
    startedAt: t0,
    ticks,
    clients: clients.map((c) => c.sample),
    agents: { batches: t.batches, dropped: t.dropped, thinned: t.thinned },
  });
}

// ---------------------------------------------------------------------------------------------- main

function specFor(name: ProfileName): ProfileSpec {
  const base = name === 'custom' ? { ...PROFILES.baseline } : { ...PROFILES[name] };
  const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  return {
    nodes: num(args.nodes, base.nodes),
    hz: num(args.hz, base.hz),
    clients: num(args.clients, base.clients),
    durationSec: num(args.duration, base.durationSec),
    recoverSec: num(args.recover, base.recoverSec),
    recoverHz: num(args['recover-hz'], base.recoverHz),
  };
}

function writeReport(m: MachineInfo, runs: RunSummary[]): void {
  const file = args.out;
  // Everything from the first marker on (the notes, then the profile sections) is kept; the header is redone.
  let doc = existsSync(file) ? readFileSync(file, 'utf8') : NOTES_STUB;
  const first = doc.indexOf('<!-- stress:');
  doc = renderHeader(m, new Date().toISOString().slice(0, 10)) + '\n' + (first >= 0 ? doc.slice(first) : NOTES_STUB);
  for (const r of runs) doc = upsertSection(doc, r.profile, renderSection(r));
  writeFileSync(file, doc.replace(/\n{3,}/g, '\n\n'));
  log(`wrote ${path.relative(ROOT, file)}`);
}

async function main(): Promise<void> {
  guardRemote();
  const names: ProfileName[] = args.profile === 'all' ? ['baseline', 'heavy', 'high', 'max'] : [args.profile as ProfileName];
  for (const n of names) if (!['baseline', 'heavy', 'high', 'max', 'custom'].includes(n)) throw new Error(`unknown profile "${n}"`);

  await mongoose.connect(args.mongo, { serverSelectionTimeoutMS: 5000 });
  const m = await machine();
  const token = await login();
  const runs: RunSummary[] = [];
  try {
    for (const [i, name] of names.entries()) {
      if (i > 0) {
        log(`pausing ${args.pause} s between profiles`);
        await sleep(Number(args.pause) * 1000);
      }
      const spec = specFor(name);
      const command = `npm run stress -- --profile ${name}` + (name === 'custom' ? ` --nodes ${spec.nodes} --hz ${spec.hz} --clients ${spec.clients} --duration ${spec.durationSec}` : '');
      const r = await runProfile(name, spec, token, command);
      runs.push(r);
      log(
        `${name}: accepted ${Math.round(r.acceptedEps)}/${r.targetEps} ev/s · 429 batches ${r.batches429}/${r.batches} · ` +
          `delivery p95 ${Math.round(r.delivery.p95)} ms · ingest→client p95 ${Math.round(r.e2e.p95)} ms · lag p99 max ${Math.round(r.server.loopLagP99Max)} ms · ` +
          `shedding ${r.server.sheddingSeconds}s${r.recoveredAfterSec !== null ? ` · recovered after ${r.recoveredAfterSec}s` : ''}`,
      );
    }
  } finally {
    await disableAgents();
    await mongoose.disconnect();
  }
  if (!args['no-write']) writeReport(m, runs);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[stress] failed:', err instanceof Error ? err.message : err);
    void mongoose.disconnect().finally(() => process.exit(1));
  },
);
