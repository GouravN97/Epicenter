import { describe, expect, it } from 'vitest';
import { TelemetryEventSchema, buildFleet } from '@epicenter/shared';
import { NOMINAL_GATEWAY_RPS, World, latencyFactor, serviceLoads, serviceSummary } from './world';

/** Runs the world for `seconds` at 2 Hz and returns the service means over the last 30 s. */
function run(world: World, seconds: number, t0 = 1_700_000_000_000) {
  let last: ReturnType<World['step']> = [];
  const acc: ReturnType<typeof serviceSummary>[] = [];
  for (let i = 0; i < seconds * 2; i++) {
    last = world.step(t0 + i * 500, 0.5);
    if (i >= (seconds - 30) * 2) acc.push(serviceSummary(last));
  }
  const mean = Object.fromEntries(
    Object.keys(acc[0]!).map((svc) => [
      svc,
      Object.fromEntries(
        Object.keys(acc[0]![svc]!).map((k) => [k, acc.reduce((a, s) => a + (s[svc] as any)[k], 0) / acc.length]),
      ),
    ]),
  ) as ReturnType<typeof serviceSummary>;
  return { last, mean };
}

describe('serviceLoads', () => {
  it('propagates gateway load down the edges by call fraction', () => {
    const l = serviceLoads(1000);
    expect(l['edge-gateway']).toBe(1000);
    expect(l.auth).toBeCloseTo(1000);
    expect(l['catalog-api']).toBeCloseTo(700);
    expect(l['orders-api']).toBeCloseTo(200);
    expect(l.payments).toBeCloseTo(120);
    // worker consumes what orders publishes; queue serves orders' writes plus worker's reads
    expect(l.worker).toBeCloseTo(200);
    expect(l.queue).toBeCloseTo(400);
    expect(l.cache).toBeCloseTo(1000 + 1050);
    expect(l.db).toBeCloseTo(100 + 280 + 400 + 300);
  });

  it('is linear in gateway load', () => {
    const a = serviceLoads(500);
    const b = serviceLoads(5000);
    for (const k of Object.keys(a) as (keyof typeof a)[]) expect(b[k]).toBeCloseTo(a[k] * 10);
  });
});

describe('World', () => {
  it('emits one schema-valid sample per node with plausible values', () => {
    const { last, mean } = run(new World({ seed: 1 }), 60);
    expect(last).toHaveLength(buildFleet().length);
    for (const s of last) {
      const r = TelemetryEventSchema.safeParse({ v: 1, nodeId: s.nodeId, bootId: 'abc123', seq: 0, ts: 1, m: s.m });
      expect(r.success).toBe(true);
    }
    for (const [svc, m] of Object.entries(mean)) {
      expect(m.cpu, `${svc} cpu`).toBeGreaterThan(10);
      expect(m.cpu, `${svc} cpu`).toBeLessThan(70);
      expect(m.err, `${svc} err`).toBeLessThan(1);
      expect(m.mem, `${svc} mem`).toBeGreaterThan(25);
      expect(m.mem, `${svc} mem`).toBeLessThan(70);
    }
    // gateway latency includes its dependencies, so it is well above its own base
    expect(mean['edge-gateway']!.lat).toBeGreaterThan(mean.auth!.lat);
    expect(mean['edge-gateway']!.rps * 6).toBeGreaterThan(NOMINAL_GATEWAY_RPS * 0.6);
  });

  it('is deterministic for a seed', () => {
    expect(run(new World({ seed: 7 }), 31).last).toEqual(run(new World({ seed: 7 }), 31).last);
  });

  it('a slow db cascades latency into its transitive dependents but not into queue or payments', () => {
    const base = run(new World({ seed: 3 }), 60).mean;
    const w = new World({ seed: 3 });
    w.effects.service.db = { latMul: 8 };
    const slow = run(w, 60).mean;
    for (const svc of ['db', 'auth', 'catalog-api', 'orders-api', 'worker', 'edge-gateway']) {
      expect(slow[svc]!.lat, svc).toBeGreaterThan(base[svc]!.lat * 1.3);
    }
    for (const svc of ['queue', 'payments', 'cache']) {
      expect(slow[svc]!.lat / base[svc]!.lat, svc).toBeLessThan(1.15);
    }
  });

  it('a cache outage raises errors in auth and catalog', () => {
    const w = new World({ seed: 4 });
    w.effects.service.cache = { errAdd: 60 };
    const m = run(w, 40).mean;
    expect(m.auth!.err).toBeGreaterThan(30);
    expect(m['catalog-api']!.err).toBeGreaterThan(30);
    expect(m.payments!.err).toBeLessThan(1);
  });

  it('a killed node stops emitting', () => {
    const w = new World({ seed: 5 });
    const id = buildFleet()[0]!.nodeId;
    w.effects.node[id] = { killed: true };
    const out = w.step(Date.now(), 0.5);
    expect(out.find((s) => s.nodeId === id)).toBeUndefined();
    expect(out).toHaveLength(buildFleet().length - 1);
  });

  it('latency factor grows sharply near saturation', () => {
    expect(latencyFactor(0)).toBe(1);
    expect(latencyFactor(50)).toBeCloseTo(2);
    expect(latencyFactor(90)).toBeCloseTo(10);
    expect(latencyFactor(150)).toBeCloseTo(latencyFactor(97));
  });
});
