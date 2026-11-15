// Pure parts of the stress tool: quantiles, run summaries and the Markdown written to docs/BENCHMARKS.md.
// No I/O here, so it is unit-tested (report.test.ts).
import type { PipelineStats } from '@epicenter/shared';

export type ProfileName = 'baseline' | 'heavy' | 'high' | 'max' | 'custom';

export interface ProfileSpec {
  nodes: number;
  hz: number;
  clients: number;
  /** Seconds of measured load. */
  durationSec: number;
  /** Seconds after the load, at `recoverHz`, to show whether shedding switches off again. 0 = none. */
  recoverSec: number;
  recoverHz: number;
}

export const PROFILES: Record<Exclude<ProfileName, 'custom'>, ProfileSpec> = {
  baseline: { nodes: 48, hz: 2, clients: 10, durationSec: 60, recoverSec: 0, recoverHz: 0 },
  heavy: { nodes: 500, hz: 5, clients: 200, durationSec: 60, recoverSec: 0, recoverHz: 0 },
  high: { nodes: 2000, hz: 5, clients: 200, durationSec: 60, recoverSec: 0, recoverHz: 0 },
  // 50 clients: with 10,000 nodes each fleet delta is large, and 200 clients would make the load generator
  // (one process, on the same machine) the bottleneck instead of the server. 90 s: past the aggregator's
  // 60 s retention, so memory has levelled off by the end.
  max: { nodes: 10_000, hz: 5, clients: 50, durationSec: 90, recoverSec: 30, recoverHz: 0.5 },
};

/** Linear-interpolated quantile of an unsorted sample; NaN when empty. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const max = (xs: readonly number[]): number => (xs.length ? Math.max(...xs) : NaN);

/** One second of the run, as seen by the tool. */
export interface Tick {
  /** Seconds since the load started (negative during warm-up). */
  t: number;
  phase: 'warmup' | 'load' | 'recover';
  /** Server stats polled that second (GET /meta/stats); null if the poll failed or timed out. */
  stats: PipelineStats | null;
  /** Events the tool's agents had delivered (2xx) in that second. */
  sent: number;
  /** Batches answered 429 in that second. */
  batches429: number;
}

export interface ClientSample {
  /** Socket delivery: client receipt − meta:pt emit time, ms. */
  deliveryMs: number[];
  /** Ingest-to-screen: client receipt of node:pt − start of that point's 1-second bucket, ms. */
  e2eMs: number[];
  messages: number;
  bytes: number;
  connected: boolean;
  /** Seconds the client was measured. */
  seconds: number;
}

export interface RunSummary {
  profile: ProfileName;
  spec: ProfileSpec;
  command: string;
  startedAt: number;
  targetEps: number;
  /** Mean server-accepted events/s during the load phase. */
  acceptedEps: number;
  sentEvents: number;
  batches: number;
  batches429: number;
  /** Events the agents dropped (buffer full, expired) or thinned under backpressure. */
  agentDropped: number;
  agentThinned: number;
  clientsConnected: number;
  delivery: { p50: number; p95: number; p99: number; samples: number };
  e2e: { p50: number; p95: number; p99: number; samples: number };
  perClientMsgsPerSec: number;
  perClientKBPerSec: number;
  server: {
    loopLagP99Max: number;
    loopLagP99Mean: number;
    rssMbMax: number;
    writeMsMean: number;
    writeMsMax: number;
    writeBatchMean: number;
    writeDroppedTotal: number;
    sheddingSeconds: number;
    shed429Total: number;
    emitsPerSecMean: number;
    bytesOutPerSecMean: number;
  };
  /** Seconds from the end of the load until shedding stayed off; null if it never shed or never recovered. */
  recoveredAfterSec: number | null;
  timeline: Tick[];
}

export function summarize(input: {
  profile: ProfileName;
  spec: ProfileSpec;
  command: string;
  startedAt: number;
  ticks: Tick[];
  clients: ClientSample[];
  agents: { batches: number; dropped: number; thinned: number };
}): RunSummary {
  const { spec, ticks, clients } = input;
  const load = ticks.filter((t) => t.phase === 'load');
  const stats = load.map((t) => t.stats).filter((s): s is PipelineStats => s !== null);
  const deliv = clients.flatMap((c) => c.deliveryMs);
  const e2e = clients.flatMap((c) => c.e2eMs);
  const connected = clients.filter((c) => c.connected);
  const secs = connected.map((c) => Math.max(1, c.seconds));
  const sheddingSeconds = stats.filter((s) => s.shedding).length;

  // Recovery: first second after the load from which shedding stays off to the end.
  let recoveredAfterSec: number | null = null;
  const after = ticks.filter((t) => t.phase === 'recover' && t.stats);
  const shedEver = sheddingSeconds > 0 || after.some((t) => t.stats!.shedding);
  if (shedEver && after.length) {
    let lastOn = -1;
    after.forEach((t, i) => t.stats!.shedding && (lastOn = i));
    if (lastOn < after.length - 1) recoveredAfterSec = lastOn + 1;
  }

  return {
    profile: input.profile,
    spec,
    command: input.command,
    startedAt: input.startedAt,
    targetEps: spec.nodes * spec.hz,
    acceptedEps: mean(stats.map((s) => s.accepted)),
    sentEvents: load.reduce((a, t) => a + t.sent, 0),
    batches: input.agents.batches,
    batches429: ticks.reduce((a, t) => a + t.batches429, 0),
    agentDropped: input.agents.dropped,
    agentThinned: input.agents.thinned,
    clientsConnected: connected.length,
    delivery: { p50: quantile(deliv, 0.5), p95: quantile(deliv, 0.95), p99: quantile(deliv, 0.99), samples: deliv.length },
    e2e: { p50: quantile(e2e, 0.5), p95: quantile(e2e, 0.95), p99: quantile(e2e, 0.99), samples: e2e.length },
    perClientMsgsPerSec: mean(connected.map((c, i) => c.messages / secs[i]!)),
    perClientKBPerSec: mean(connected.map((c, i) => c.bytes / 1024 / secs[i]!)),
    server: {
      loopLagP99Max: max(stats.map((s) => s.loopLagP99)),
      loopLagP99Mean: mean(stats.map((s) => s.loopLagP99)),
      rssMbMax: max(stats.map((s) => s.rssMb)),
      writeMsMean: mean(stats.map((s) => s.writeMs)),
      writeMsMax: max(stats.map((s) => s.writeMs)),
      writeBatchMean: mean(stats.map((s) => s.writeBatch)),
      writeDroppedTotal: stats.reduce((a, s) => a + s.writeDropped, 0),
      sheddingSeconds,
      shed429Total: stats.reduce((a, s) => a + s.shed429, 0),
      emitsPerSecMean: mean(stats.map((s) => s.emitsPerSec)),
      bytesOutPerSecMean: mean(stats.map((s) => s.bytesOutPerSec)),
    },
    recoveredAfterSec,
    timeline: ticks,
  };
}

// ---------------------------------------------------------------------------------------------- Markdown

const n0 = (x: number): string => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '–');
const n1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '–');
const ms = (x: number): string => (Number.isFinite(x) ? `${Math.round(x)} ms` : '–');
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '–');

export const sectionStart = (p: ProfileName): string => `<!-- stress:${p} -->`;
export const sectionEnd = (p: ProfileName): string => `<!-- /stress:${p} -->`;

const TITLES: Record<ProfileName, string> = {
  baseline: 'Baseline: the demo fleet',
  heavy: 'Heavy: 10× the nodes, 2.5× the rate, 200 dashboards',
  high: 'High: 10,000 events/s to 200 dashboards',
  max: 'Max: 50,000 events/s from 10,000 nodes',
  custom: 'Custom run',
};

/** Timeline rows every `every` seconds: what the server reported while the load ran and after. */
function timelineTable(ticks: Tick[], every: number): string[] {
  const rows = ticks.filter((t) => t.phase !== 'warmup' && t.stats && Math.round(t.t) % every === 0);
  if (!rows.length) return [];
  const L = ['| t (s) | phase | accepted ev/s | 429s | loop lag p99 | write buffer | RSS | shedding |', '|---:|---|---:|---:|---:|---:|---:|:---:|'];
  for (const t of rows) {
    const s = t.stats!;
    L.push(`| ${Math.round(t.t)} | ${t.phase} | ${n0(s.accepted)} | ${n0(s.shed429)} | ${ms(s.loopLagP99)} | ${n0(s.writeBuffer)} | ${n0(s.rssMb)} MB | ${s.shedding ? 'on' : ''} |`);
  }
  return L;
}

export function renderSection(r: RunSummary): string {
  const s = r.spec;
  const L: string[] = [sectionStart(r.profile), `## ${TITLES[r.profile]}`, ''];
  L.push(`${n0(s.nodes)} nodes × ${s.hz} Hz = **${n0(r.targetEps)} events/s offered**, ${s.clients} dashboard clients, ${s.durationSec} s measured` +
    (s.recoverSec ? `, then ${s.recoverSec} s at ${s.recoverHz} Hz to watch recovery.` : '.'));
  L.push('', '```', r.command, '```', '');
  L.push('| Measure | Result |', '|---|---|');
  L.push(`| Events accepted by the server | **${n0(r.acceptedEps)} /s** (${pct(r.acceptedEps, r.targetEps)} of offered) |`);
  L.push(`| Batches refused with 429 | ${n0(r.batches429)} of ${n0(r.batches)} (${pct(r.batches429, r.batches)}) |`);
  L.push(`| Events thinned / dropped by agents under backpressure | ${n0(r.agentThinned)} / ${n0(r.agentDropped)} |`);
  L.push(`| Dashboard clients connected | ${r.clientsConnected} of ${s.clients} |`);
  L.push(`| Socket delivery (server emit → client), p50 / p95 / p99 | ${ms(r.delivery.p50)} / ${ms(r.delivery.p95)} / ${ms(r.delivery.p99)} (${n0(r.delivery.samples)} samples) |`);
  L.push(`| Ingest → client (start of 1 s bucket → node:pt received), p50 / p95 / p99 | ${ms(r.e2e.p50)} / ${ms(r.e2e.p95)} / ${ms(r.e2e.p99)} (${n0(r.e2e.samples)} samples) |`);
  L.push(`| Per client: messages / data received | ${n1(r.perClientMsgsPerSec)} /s · ${n1(r.perClientKBPerSec)} kB/s |`);
  L.push(`| Server socket emits / bytes out | ${n0(r.server.emitsPerSecMean)} /s · ${n1(r.server.bytesOutPerSecMean / 1024)} kB/s |`);
  L.push(`| Event-loop lag p99 (mean / worst second) | ${ms(r.server.loopLagP99Mean)} / ${ms(r.server.loopLagP99Max)} |`);
  L.push(`| MongoDB bulk write (mean batch · mean / worst time) | ${n0(r.server.writeBatchMean)} points · ${ms(r.server.writeMsMean)} / ${ms(r.server.writeMsMax)} |`);
  L.push(`| Points dropped by the write buffer | ${n0(r.server.writeDroppedTotal)} |`);
  L.push(`| Server memory (RSS, peak) | ${n0(r.server.rssMbMax)} MB |`);
  L.push(`| Seconds with load shedding on | ${r.server.sheddingSeconds} of ${s.durationSec} |`);
  if (s.recoverSec) {
    L.push(`| Shedding off for good after the load dropped | ${r.recoveredAfterSec === null ? (r.server.sheddingSeconds ? 'not within the recovery window' : 'never shed') : `${r.recoveredAfterSec} s`} |`);
  }
  const tl = timelineTable(r.timeline, r.profile === 'max' ? 5 : 10);
  if (tl.length) L.push('', '<details><summary>Timeline</summary>', '', ...tl, '', '</details>');
  L.push('', sectionEnd(r.profile));
  return L.join('\n');
}

/** Replaces this profile's section in `doc` (between its markers), or appends it at the end. */
export function upsertSection(doc: string, profile: ProfileName, section: string): string {
  const a = doc.indexOf(sectionStart(profile));
  const b = doc.indexOf(sectionEnd(profile));
  if (a >= 0 && b > a) return doc.slice(0, a) + section + doc.slice(b + sectionEnd(profile).length);
  return doc.replace(/\s*$/, '\n\n') + section + '\n';
}

/** The hand-written findings, kept between the generated header and the profile sections. */
export const NOTES_START = '<!-- stress:notes -->';
export const NOTES_END = '<!-- /stress:notes -->';
export const NOTES_STUB = `${NOTES_START}\n## What the numbers say\n\n_Written after the runs._\n\n${NOTES_END}`;

export interface MachineInfo {
  cpu: string;
  cores: number;
  memGb: number;
  os: string;
  node: string;
  mongo: string;
}

export function renderHeader(m: MachineInfo, date: string): string {
  return [
    '# Benchmarks',
    '',
    '<!-- Generated by `npm run stress`; profile sections are replaced on each run. Edit the notes at the end freely. -->',
    '',
    `Measured on **${date}** on one machine running everything: the API server, MongoDB, the load generator and`,
    'every dashboard client.',
    '',
    '| | |',
    '|---|---|',
    `| CPU | ${m.cpu} (${m.cores} threads) |`,
    `| Memory | ${m.memGb} GB |`,
    `| OS | ${m.os} |`,
    `| Node.js | ${m.node} |`,
    `| MongoDB | ${m.mongo} (local, Docker) |`,
    '',
    '**How it works.** `tools/stress` registers its own ingest agents and sends events through the real',
    '`POST /api/v1/ingest` path (agent key, token bucket, load shedding, validation, dedup, aggregation, bulk writes),',
    'using the simulator\'s agent code, so batches, 429 back-off and thinning behave as in production. It opens',
    'the requested number of Socket.IO dashboard clients; each joins its fleet rooms, `meta` and three random',
    '`node:` rooms, like a user on the Overview with three node pages open. The server\'s own numbers come from',
    '`GET /api/v1/meta/stats` once a second.',
    '',
    '**Reading the latencies.** *Socket delivery* is the time from the server emitting `meta:pt` to a client',
    'receiving it (same machine, so no clock skew). *Ingest → client* starts at the beginning of a point\'s',
    '1-second bucket, so it includes the bucket itself (up to 1 s) and the aggregator\'s 2 s grace period for late',
    'events, by design; the rest is processing and delivery.',
    '',
  ].join('\n');
}
