// zod schemas (plan §4, §6). The same schemas validate on the agent and on the server.
import { z } from 'zod';
import {
  ALERTS_PAGE_DEFAULT,
  ALERTS_PAGE_MAX,
  ALERT_RULES,
  ALERT_STATES,
  BOOT_ID_LEN,
  EVENT_VERSION,
  INCIDENT_STATES,
  INGEST_MAX_EVENTS,
  NODE_ID_MAX_LEN,
  NODE_ID_PATTERN,
  ROLES,
  SEVERITIES,
} from './constants';
import { SERVICE_IDS, TEAMS } from './topology';

// ---------------------------------------------------------------- telemetry (§4)

const finite = z.number().finite();
/** Percent metrics: finite, clamped into 0–100 (out-of-range values are clamped, not rejected). */
const percent = finite.transform((x) => Math.min(100, Math.max(0, x)));
const nonNeg = finite.min(0);

export const NodeIdSchema = z.string().min(1).max(NODE_ID_MAX_LEN).regex(NODE_ID_PATTERN);

export const MetricsSchema = z.object({
  cpu: percent,
  mem: percent,
  disk: percent,
  netIn: nonNeg,
  netOut: nonNeg,
  lat: nonNeg,
  err: percent,
  rps: nonNeg,
});

export const TelemetryEventSchema = z.object({
  v: z.literal(EVENT_VERSION),
  nodeId: NodeIdSchema,
  bootId: z.string().length(BOOT_ID_LEN).regex(/^[a-z0-9]+$/i),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ts: z.number().int().positive(),
  m: MetricsSchema,
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
/** What an agent constructs (before clamping transforms). */
export type TelemetryEventInput = z.input<typeof TelemetryEventSchema>;

/**
 * Batch envelope. `events` items are left unvalidated here so the server can validate each event on its own
 * (one bad event must not reject the batch, §6.1). Validate items with TelemetryEventSchema.
 */
export const IngestBatchEnvelopeSchema = z.object({
  agentId: z.string().min(1).max(64),
  sentAt: z.number().int().positive(),
  events: z.array(z.unknown()).min(1).max(INGEST_MAX_EVENTS),
});

/** Fully typed batch, used by agents and tests. */
export const IngestBatchSchema = IngestBatchEnvelopeSchema.extend({
  events: z.array(TelemetryEventSchema).min(1).max(INGEST_MAX_EVENTS),
});
export type IngestBatch = z.infer<typeof IngestBatchSchema>;

export interface IngestResponse {
  accepted: number;
  duplicate: number;
  /** Accepted but older than the newest seq / corrected a finalized bucket. */
  late: number;
  rejected: number;
}

// ---------------------------------------------------------------- auth + users (§6.3)

export const RoleSchema = z.enum(ROLES);
export const TeamSchema = z.enum(TEAMS);
export const ServiceIdSchema = z.enum(SERVICE_IDS);

export const LoginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: z.infer<typeof RoleSchema>;
  teams: z.infer<typeof TeamSchema>[];
}

export interface LoginResponse {
  token: string;
  user: UserDTO;
}

/** JWT payload. */
export interface AuthClaims {
  sub: string;
  role: z.infer<typeof RoleSchema>;
  teams: z.infer<typeof TeamSchema>[];
  name: string;
}

export interface ApiError {
  error: { code: string; message: string; issues?: unknown[] };
}

// ---------------------------------------------------------------- query params (§6.2)

/** Epoch ms from a query string. */
const epochMs = z.coerce.number().int().nonnegative();

export const ResolutionSchema = z.enum(['auto', '1s', '1m']);
export type Resolution = z.infer<typeof ResolutionSchema>;

const rangeRefine = <T extends { from: number; to: number }>(r: T) => r.to > r.from;
const rangeMsg = { message: '`to` must be greater than `from`', path: ['to'] };

export const NodeMetricsParamsSchema = z.object({ nodeId: NodeIdSchema });
export const NodeMetricsQuerySchema = z
  .object({ from: epochMs, to: epochMs, res: ResolutionSchema.default('auto') })
  .refine(rangeRefine, rangeMsg);

export const ServiceMetricsParamsSchema = z.object({ serviceId: ServiceIdSchema });
export const ServiceMetricsQuerySchema = z
  .object({ from: epochMs, to: epochMs, res: ResolutionSchema.default('auto') })
  .refine(rangeRefine, rangeMsg);

/** `services=a,b` → ['a','b']. Empty or missing means every service the user may see. */
export const ReplayQuerySchema = z
  .object({
    from: epochMs,
    to: epochMs,
    services: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []))
      .pipe(z.array(ServiceIdSchema)),
  })
  .refine(rangeRefine, rangeMsg);

export const AlertsQuerySchema = z.object({
  state: z.enum(ALERT_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(ALERTS_PAGE_MAX).default(ALERTS_PAGE_DEFAULT),
  /** Cursor: return alerts that started before this epoch ms. */
  before: epochMs.optional(),
});

export const ObjectIdParamSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });

export const IncidentNoteBodySchema = z.object({ text: z.string().trim().min(1).max(2000) });

/**
 * Columnar history response for /metrics/node, /metrics/service and each series of /replay.
 * `t` is sorted ascending and unique. Every metric array has the same length as `t`.
 */
export type ColumnarSeries = {
  res: '1s' | '1m';
  t: number[];
  rev: number[];
} & { [K in 'cpu' | 'mem' | 'disk' | 'netIn' | 'netOut' | 'lat' | 'err' | 'rps']: number[] };

export interface NodeSeriesResponse extends ColumnarSeries {
  nodeId: string;
}
export interface ServiceSeriesResponse extends ColumnarSeries {
  serviceId: string;
}
export interface ReplayResponse {
  from: number;
  to: number;
  nodes: NodeSeriesResponse[];
}

// ---------------------------------------------------------------- alerts + incidents DTOs (§5, §7.3)

export interface AlertDTO {
  id: string;
  key: string;
  nodeId: string;
  serviceId: string;
  team: string;
  metric: string;
  rule: (typeof ALERT_RULES)[number];
  severity: (typeof SEVERITIES)[number];
  state: (typeof ALERT_STATES)[number];
  value: number;
  threshold: number;
  message: string;
  startedAt: number;
  ackedBy?: string | null;
  resolvedAt?: number | null;
  incidentId?: string | null;
}

export interface IncidentDTO {
  id: string;
  title: string;
  state: (typeof INCIDENT_STATES)[number];
  epicenter: string | null;
  confidence: number;
  affected: string[];
  blastRadius: string[];
  startedAt: number;
  endedAt: number | null;
}

export type TimelineKind = 'alert' | 'resolve' | 'note' | 'epicenter' | 'chaos' | 'system';
export interface TimelineEntry {
  ts: number;
  kind: TimelineKind;
  text: string;
  user?: { id: string; name: string } | null;
}

export interface ChaosScorecard {
  runId: string;
  scenario: ChaosScenarioId;
  target: string | null;
  startedAt: number;
  detectedAt: number | null;
  /** detectedAt − startedAt, ms. */
  timeToDetectMs: number | null;
  detectedEpicenter: string | null;
  correct: boolean | null;
}

export interface IncidentDetailDTO extends IncidentDTO {
  alerts: AlertDTO[];
  timeline: TimelineEntry[];
  chaos: ChaosScorecard | null;
}

// ---------------------------------------------------------------- chaos (§6.3, §8.9)

export const CHAOS_SCENARIO_IDS = [
  'cpu-spike',
  'memory-leak',
  'node-kill',
  'slow-db',
  'cache-outage',
  'traffic-surge',
  'duplicate-storm',
  'malformed-flood',
] as const;
export type ChaosScenarioId = (typeof CHAOS_SCENARIO_IDS)[number];

export interface ChaosScenarioDef {
  id: ChaosScenarioId;
  name: string;
  description: string;
  /** What `target` means: a nodeId, a serviceId, or nothing. */
  targetKind: 'node' | 'service' | 'none';
  /** Default target when none is given (service id), if any. */
  defaultTarget?: string;
  defaultDurationSec: number;
  expected: string;
}

export const CHAOS_SCENARIOS: readonly ChaosScenarioDef[] = [
  { id: 'cpu-spike', name: 'CPU spike', description: '+60 cpu on one node', targetKind: 'node', defaultDurationSec: 60, expected: 'z-score then threshold alert, single-service incident' },
  { id: 'memory-leak', name: 'Memory leak', description: 'mem +0.25/s on one node', targetKind: 'node', defaultDurationSec: 240, expected: 'Predictive alert before the threshold alert' },
  { id: 'node-kill', name: 'Kill node', description: 'Node stops emitting', targetKind: 'node', defaultDurationSec: 45, expected: 'Heartbeat alert within ~5–8 s; hex turns silent' },
  { id: 'slow-db', name: 'Slow database', description: 'db latency ×8', targetKind: 'service', defaultTarget: 'db', defaultDurationSec: 90, expected: 'Cascade into auth, catalog, orders, worker, gateway; epicenter = db' },
  { id: 'cache-outage', name: 'Cache outage', description: 'cache err 60%', targetKind: 'service', defaultTarget: 'cache', defaultDurationSec: 90, expected: 'Cascade into auth and catalog; epicenter = cache' },
  { id: 'traffic-surge', name: '10× traffic', description: 'gateway rps ×10 and sim hz ×5', targetKind: 'none', defaultDurationSec: 60, expected: 'Fleet-wide load; eps jump, possible shedding' },
  { id: 'duplicate-storm', name: 'Duplicate storm', description: 'Every batch sent 3×, shuffled, 10% delayed 1.5 s', targetKind: 'none', defaultDurationSec: 60, expected: 'No visual glitch; duplicate / outOfOrder / lateCorrected counters climb' },
  { id: 'malformed-flood', name: 'Malformed flood', description: '200 req/s of invalid bodies from a second agent key', targetKind: 'none', defaultDurationSec: 60, expected: 'rejected and shed429 climb; dashboards unaffected' },
];

export const ChaosStartBodySchema = z.object({
  scenario: z.enum(CHAOS_SCENARIO_IDS),
  target: z.string().min(1).max(NODE_ID_MAX_LEN).optional(),
  durationSec: z.number().int().min(5).max(1800).optional(),
});
export type ChaosStartBody = z.infer<typeof ChaosStartBodySchema>;
