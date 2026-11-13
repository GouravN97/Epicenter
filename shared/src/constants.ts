// Shared constants. Plan §4, §7, §8. Change only by agreement between Person A and Person B.

/** Metric column order. It is the column order on the wire and in the client buffers. Do not reorder. */
export const METRICS = ['cpu', 'mem', 'disk', 'netIn', 'netOut', 'lat', 'err', 'rps'] as const;
export type MetricName = (typeof METRICS)[number];
export type MetricValues = Record<MetricName, number>;

/** Display units, same order as METRICS. */
export const METRIC_UNITS: Record<MetricName, string> = {
  cpu: '%',
  mem: '%',
  disk: '%',
  netIn: 'kB/s',
  netOut: 'kB/s',
  lat: 'ms',
  err: '%',
  rps: 'req/s',
};

/** Metrics that are percentages and are clamped to 0–100. */
export const PERCENT_METRICS: readonly MetricName[] = ['cpu', 'mem', 'disk', 'err'];

// ---------------------------------------------------------------- identity / time

export const EVENT_VERSION = 1;
export const NODE_ID_MAX_LEN = 64;
export const NODE_ID_PATTERN = /^[a-z0-9.-]+$/;
export const BOOT_ID_LEN = 6;

/** Bucket size for 1-second rollups. bucketTs = floor(ts / 1000) * 1000. */
export const BUCKET_MS = 1000;
export const MINUTE_MS = 60_000;
export const bucketOf = (ts: number): number => Math.floor(ts / BUCKET_MS) * BUCKET_MS;
export const minuteOf = (ts: number): number => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

// ---------------------------------------------------------------- ingest limits (§4, §8.1)

export const INGEST_MAX_EVENTS = 500;
export const INGEST_MAX_BODY = '256kb';
export const INGEST_MAX_BODY_BYTES = 256 * 1024;
/** Reject events whose ts is more than this far in the future. */
export const MAX_FUTURE_MS = 5_000;
/** Reject events older than this. */
export const MAX_AGE_MS = 60_000;
export const AGENT_KEY_CACHE_MS = 60_000;

// ---------------------------------------------------------------- dedup + aggregation (§8.1, §8.2)

export const DEDUP_WINDOW = 1024;
export const DEDUP_PRUNE_EVERY = 256;
export const AGG_FINALIZE_INTERVAL_MS = 250;
export const AGG_GRACE_MS = 2_000;
/** Finalized accumulators are kept this long so late events can correct them. */
export const AGG_RETAIN_FINALIZED_MS = 60_000;

// ---------------------------------------------------------------- writer (§8.3)

export const WRITER_FLUSH_MS = 1_000;
export const WRITER_FLUSH_POINTS = 1_000;
export const WRITER_BUFFER_CAP = 20_000;

// ---------------------------------------------------------------- backpressure (§8.4)

export const SHED_SAMPLE_MS = 500;
export const SHED_LAG_P99_MS = 150;
export const SHED_WRITE_BUFFER_RATIO = 0.75;
export const SHED_HOLD_MS = 1_000;
export const SHED_RETRY_AFTER_S = 2;

// ---------------------------------------------------------------- simulator / agent (§8.9)

export const SIM_DEFAULT_HZ = 2;
export const AGENT_FLUSH_MS = 500;
export const AGENT_BUFFER_CAP = 2_000;
/** On 429, samples older than this are thinned to one per second per node. */
export const AGENT_THIN_OLDER_THAN_MS = 5_000;

// ---------------------------------------------------------------- realtime (§7, §8.5)

export const BROADCAST_INTERVAL_MS = 1_000;
/** fleet:delta includes a node only if cpu or mem moved by at least this much (or status changed). */
export const FLEET_DELTA_MIN_CHANGE = 1;
export const SOCKET_SUB_LIMIT = 20;
export const SOCKET_SUB_WINDOW_MS = 10_000;
export const SOCKET_MAX_ROOMS = 100;
export const CLIENT_STATS_INTERVAL_MS = 5_000;
/** Off-screen panels unsubscribe after this long (§9.2 useRoom). */
export const OFFSCREEN_UNSUB_MS = 2_000;
/** Reconnect gap-fill fetches [lastT − this, now]. */
export const GAP_FILL_OVERLAP_MS = 5_000;

// ---------------------------------------------------------------- history API (§6.2)

export const HISTORY_MAX_POINTS = 3_600;
/** res=auto picks 1s for ranges up to this, else 1m. */
export const AUTO_1S_MAX_RANGE_MS = 30 * 60_000;
export const REPLAY_MAX_RANGE_MS = 10 * 60_000;
export const ALERTS_PAGE_DEFAULT = 50;
export const ALERTS_PAGE_MAX = 200;
export const METRICS_1S_TTL_S = 6 * 3600;
export const METRICS_1M_TTL_S = 7 * 24 * 3600;
export const SERIES_BUFFER_CAPACITY = 3_600;

// ---------------------------------------------------------------- detection + incidents (§8.6, §8.7)

export const DETECTED_METRICS = ['cpu', 'mem', 'lat', 'err', 'netIn'] as const;
export type DetectedMetric = (typeof DETECTED_METRICS)[number];

export const HEARTBEAT_TIMEOUT_MS = 5_000;
export const ZSCORE_WARMUP = 30;
export const ZSCORE_THRESHOLD = 4;
export const ZSCORE_CRIT = 8;
export const ZSCORE_STREAK = 3;
export const EWMA_ALPHA = 0.05;
export const MIN_DELTA: Record<DetectedMetric, number> = { cpu: 15, mem: 10, lat: 40, err: 2, netIn: 500 };
export const RESOLVE_STREAK = 15;
export const TREND_WINDOW = 120;
export const TREND_MIN_R2 = 0.8;
export const TREND_HORIZON_S = 300;
export const TREND_MEM_LIMIT = 95;

export const INCIDENT_JOIN_WINDOW_MS = 60_000;
export const INCIDENT_RESOLVE_QUIET_MS = 30_000;
export const CHAOS_LINK_WINDOW_MS = 120_000;

// ---------------------------------------------------------------- enums

export const ROLES = ['admin', 'sre', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Node / service status on the wire. Ordered by severity so Math.max works. */
export const NodeStatus = { ok: 0, warn: 1, crit: 2, silent: 3 } as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];
export const NODE_STATUS_NAMES = ['ok', 'warn', 'crit', 'silent'] as const;

export const SEVERITIES = ['warn', 'crit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALERT_STATES = ['firing', 'acked', 'resolved'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const ALERT_RULES = ['zscore', 'threshold', 'heartbeat', 'predictive'] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export const INCIDENT_STATES = ['open', 'resolved'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const AUTH_TOKEN_TTL = '12h';
