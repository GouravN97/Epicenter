import { describe, expect, it } from 'vitest';
import { NodeStatus, RESOLVE_STREAK, type AlertDTO, type MetricValues } from '@epicenter/shared';
import { Detector, linearFit } from './detector';

const NODE = 'us-east-1a.orders-api.01'; // orders-api SLO 200 ms → lat threshold 600 ms
const T0 = 1_700_000_000_000;

/** Deterministic noise in [-1, 1]. */
function noise(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

function harness() {
  let id = 0;
  const d = new Detector((n) => (n.includes('orders-api') ? { serviceId: 'orders-api', team: 'commerce' } : undefined), () => `id${++id}`);
  const ev: { kind: string; a: AlertDTO }[] = [];
  d.on({
    fire: (a) => ev.push({ kind: 'fire', a: { ...a } }),
    update: (a) => ev.push({ kind: 'update', a: { ...a } }),
    resolve: (a) => ev.push({ kind: 'resolve', a: { ...a } }),
  });
  let t = T0;
  const rnd = noise();
  const base: MetricValues = { cpu: 40, mem: 50, disk: 30, netIn: 200, netOut: 400, lat: 100, err: 0.2, rps: 50 };
  /** Feeds `n` points; `f` overrides metrics for each point (index i). */
  const feed = (n: number, f: (i: number) => Partial<MetricValues> = () => ({})) => {
    for (let i = 0; i < n; i++) {
      t += 1000;
      const m: MetricValues = {
        ...base,
        cpu: base.cpu + 2 * rnd(),
        mem: base.mem + 0.3 * rnd(),
        lat: base.lat + 5 * rnd(),
        err: Math.max(0, base.err + 0.05 * rnd()),
        netIn: base.netIn + 10 * rnd(),
        ...f(i),
      };
      d.onPoint({ nodeId: NODE, ts: t, ...m });
    }
  };
  const fired = (rule: string, metric?: string) => ev.filter((e) => e.kind === 'fire' && e.a.rule === rule && (!metric || e.a.metric === metric));
  const resolved = (rule: string, metric?: string) => ev.filter((e) => e.kind === 'resolve' && e.a.rule === rule && (!metric || e.a.metric === metric));
  return { d, ev, feed, fired, resolved, now: () => t };
}

describe('zscore rule', () => {
  it('does nothing during warm-up or on normal noise', () => {
    const h = harness();
    h.feed(200);
    expect(h.ev).toEqual([]);
  });

  it('fires after 3 anomalous points, escalates to crit for |z| > 8, resolves after 15 normal points', () => {
    const h = harness();
    h.feed(60);
    h.feed(2, () => ({ lat: 400 }));
    expect(h.fired('zscore', 'lat')).toHaveLength(0); // streak of 2 is not enough
    h.feed(1, () => ({ lat: 100 }));
    h.feed(3, () => ({ lat: 400 }));
    const f = h.fired('zscore', 'lat');
    expect(f).toHaveLength(1);
    expect(f[0]!.a).toMatchObject({ nodeId: NODE, serviceId: 'orders-api', team: 'commerce', state: 'firing', severity: 'crit' });
    expect(f[0]!.a.message).toMatch(/lat 400ms is .*σ above baseline/);
    expect(h.d.nodeStatus(NODE)).toBe(NodeStatus.crit);

    h.feed(30, () => ({ lat: 400 })); // still anomalous: baseline frozen, no new alert, no resolve
    expect(h.fired('zscore', 'lat')).toHaveLength(1);
    expect(h.resolved('zscore', 'lat')).toHaveLength(0);

    h.feed(RESOLVE_STREAK - 1);
    expect(h.resolved('zscore', 'lat')).toHaveLength(0);
    h.feed(1);
    const r = h.resolved('zscore', 'lat');
    expect(r).toHaveLength(1);
    expect(r[0]!.a).toMatchObject({ state: 'resolved', resolvedAt: h.now() });
    expect(h.d.nodeStatus(NODE)).toBe(NodeStatus.ok);
  });

  it('ignores statistically odd but tiny moves (MIN_DELTA)', () => {
    const h = harness();
    h.feed(60, () => ({ cpu: 40 })); // perfectly flat → tiny variance
    h.feed(10, () => ({ cpu: 50 })); // huge z, but only +10 < MIN_DELTA 15
    expect(h.fired('zscore', 'cpu')).toHaveLength(0);
  });
});

describe('threshold rule', () => {
  it('cpu > 90 for 10 points → crit; resolves after 15 points under', () => {
    const h = harness();
    h.feed(5);
    h.feed(9, () => ({ cpu: 95 }));
    expect(h.fired('threshold', 'cpu')).toHaveLength(0);
    h.feed(1, () => ({ cpu: 95 }));
    expect(h.fired('threshold', 'cpu')).toHaveLength(1);
    expect(h.fired('threshold', 'cpu')[0]!.a).toMatchObject({ severity: 'crit', threshold: 90 });
    h.feed(RESOLVE_STREAK);
    expect(h.resolved('threshold', 'cpu')).toHaveLength(1);
  });

  it('an interruption resets the count', () => {
    const h = harness();
    h.feed(9, () => ({ cpu: 95 }));
    h.feed(1, () => ({ cpu: 50 }));
    h.feed(9, () => ({ cpu: 95 }));
    expect(h.fired('threshold', 'cpu')).toHaveLength(0);
  });

  it('mem > 92 ×10 → crit, err > 5 ×5 → crit, lat > 3×SLO ×5 → warn', () => {
    const h = harness();
    h.feed(10, () => ({ mem: 93 }));
    h.feed(5, () => ({ err: 7 }));
    h.feed(5, () => ({ lat: 700 }));
    expect(h.fired('threshold', 'mem')[0]!.a.severity).toBe('crit');
    expect(h.fired('threshold', 'err')[0]!.a.severity).toBe('crit');
    expect(h.fired('threshold', 'lat')[0]!.a).toMatchObject({ severity: 'warn', threshold: 600 });
  });

  it('one active alert per key: a long breach fires once', () => {
    const h = harness();
    h.feed(100, () => ({ cpu: 99 }));
    expect(h.fired('threshold', 'cpu')).toHaveLength(1);
  });
});

describe('heartbeat rule', () => {
  it('fires crit after 5 s of silence, then resolves after 15 points once data resumes', () => {
    const h = harness();
    h.feed(5);
    const last = h.now();
    h.d.checkHeartbeats(last + 5_000, [{ nodeId: NODE, lastSeen: last }]);
    expect(h.fired('heartbeat')).toHaveLength(0);
    h.d.checkHeartbeats(last + 6_000, [{ nodeId: NODE, lastSeen: last }]);
    expect(h.fired('heartbeat')).toHaveLength(1);
    expect(h.fired('heartbeat')[0]!.a).toMatchObject({ severity: 'crit', metric: 'heartbeat' });
    h.d.checkHeartbeats(last + 9_000, [{ nodeId: NODE, lastSeen: last }]);
    expect(h.fired('heartbeat')).toHaveLength(1); // still one alert
    h.feed(RESOLVE_STREAK);
    expect(h.resolved('heartbeat')).toHaveLength(1);
  });

  it('ignores nodes that never reported and unknown nodes', () => {
    const h = harness();
    h.d.checkHeartbeats(T0 + 60_000, [{ nodeId: NODE, lastSeen: 0 }, { nodeId: 'x.db.01', lastSeen: T0 }]);
    expect(h.ev).toEqual([]);
  });
});

describe('predictive memory trend', () => {
  it('a steady leak fires predictive before the mem threshold, with an ETA, then resolves when it stops', () => {
    const h = harness();
    let mem = 45;
    h.feed(400, () => ({ mem: (mem += 0.25) > 99 ? 99 : mem }));
    const p = h.fired('predictive');
    const thr = h.fired('threshold', 'mem');
    expect(p).toHaveLength(1);
    expect(thr).toHaveLength(1);
    expect(p[0]!.a.startedAt).toBeLessThan(thr[0]!.a.startedAt);
    expect(p[0]!.a.message).toMatch(/memory exhausts in ~\d+m \d+s/);
    expect(p[0]!.a.severity).toBe('warn');
    h.feed(200, () => ({ mem: 50 })); // leak fixed (restart)
    expect(h.resolved('predictive')).toHaveLength(1);
  });

  it('does not fire on flat or noisy memory', () => {
    const h = harness();
    h.feed(300);
    expect(h.fired('predictive')).toHaveLength(0);
  });

  it('linearFit', () => {
    expect(linearFit([1, 2, 3, 4])).toEqual({ slope: 1, r2: 1 });
    expect(linearFit([5, 5, 5]).slope).toBe(0);
  });
});

describe('ack', () => {
  it('acks an active alert once; the alert still resolves later', () => {
    const h = harness();
    h.feed(10, () => ({ cpu: 95 }));
    const id = h.fired('threshold', 'cpu')[0]!.a.id;
    expect(h.d.ack(id, 'u1')).toMatchObject({ state: 'acked', ackedBy: 'u1' });
    expect(h.ev.filter((e) => e.kind === 'update')).toHaveLength(1);
    h.d.ack(id, 'u2'); // second ack is a no-op
    expect(h.ev.filter((e) => e.kind === 'update')).toHaveLength(1);
    expect(h.d.nodeStatus(NODE)).toBe(NodeStatus.crit); // acked still counts
    h.feed(RESOLVE_STREAK);
    expect(h.resolved('threshold', 'cpu')).toHaveLength(1);
    expect(h.d.ack(id, 'u1')).toBeUndefined();
  });
});
