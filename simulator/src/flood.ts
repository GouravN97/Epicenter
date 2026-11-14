// malformed-flood chaos (plan §8.9): ~200 req/s of invalid ingest bodies under a second agent key. The key
// is derived from SIM_KEY exactly as server/src/db/seed.ts derives the `sim-flood` agent's key.
export const FLOOD_AGENT_ID = 'sim-flood';
export const floodKey = (simKey: string): string => `${simKey}:flood`;

const MAX_IN_FLIGHT = 64;

/** The flood's request bodies, rotated: each exercises a different rejection path on the server. */
export function floodBodies(now: number): string[] {
  const m = { cpu: 1, mem: 1, disk: 1, netIn: 1, netOut: 1, lat: 1, err: 0, rps: 1 };
  return [
    '{"agentId": "sim-flood", "events": [', // not JSON
    JSON.stringify({ agentId: FLOOD_AGENT_ID, events: [] }), // envelope invalid
    JSON.stringify({ agentId: FLOOD_AGENT_ID, sentAt: now, events: [{ v: 2 }, { nodeId: '!!' }, 42] }), // events invalid
    JSON.stringify({
      agentId: FLOOD_AGENT_ID,
      sentAt: now,
      events: [{ v: 1, nodeId: 'us-east-1a.db.01', bootId: 'flood1', seq: 1, ts: now, m }], // valid but not owned
    }),
    JSON.stringify({ agentId: FLOOD_AGENT_ID, sentAt: now, events: [{ v: 1, nodeId: 'flood-x', bootId: 'flood1', seq: 1, ts: now + 3_600_000, m }] }), // from the future
  ];
}

export interface FloodStats {
  sent: number;
  skipped: number;
  status: Record<string, number>;
}

export function startFlood(baseUrl: string, simKey: string, reqPerSec = 200): { stop(): void; stats: FloodStats } {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/ingest`;
  const key = floodKey(simKey);
  const stats: FloodStats = { sent: 0, skipped: 0, status: {} };
  let inFlight = 0;
  let i = 0;
  const TICK_MS = 50;
  const perTick = Math.max(1, Math.round((reqPerSec * TICK_MS) / 1000));
  const timer = setInterval(() => {
    const bodies = floodBodies(Date.now());
    for (let k = 0; k < perTick; k++) {
      if (inFlight >= MAX_IN_FLIGHT) {
        stats.skipped++;
        continue;
      }
      inFlight++;
      stats.sent++;
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-key': key },
        body: bodies[i++ % bodies.length],
        signal: AbortSignal.timeout(2_000),
      })
        .then(async (r) => {
          await r.arrayBuffer().catch(() => undefined);
          stats.status[r.status] = (stats.status[r.status] ?? 0) + 1;
        })
        .catch(() => (stats.status.net = (stats.status.net ?? 0) + 1))
        .finally(() => inFlight--);
    }
  }, TICK_MS);
  return { stop: () => clearInterval(timer), stats };
}
