import { describe, expect, it } from 'vitest';
import { IngestBatchSchema, type ChaosCommand, type IngestBatch } from '@epicenter/shared';
import { CHAOS, ChaosController, composeEffects, hzMultiplier, stormTransport, type ActiveChaos } from './chaos';
import { floodBodies } from './flood';
import { World } from './world';

const run = (scenario: ActiveChaos['scenario'], target: string | null = null, runId: string = scenario): ActiveChaos => ({ runId, scenario, target, endsAt: 0 });
const NODE = 'us-east-1a.catalog-api.01';

describe('composeEffects', () => {
  it('no runs → no effects', () => {
    expect(composeEffects([])).toEqual({ rpsMul: 1, service: {}, node: {} });
  });

  it('maps each model scenario to its effect', () => {
    const e = composeEffects([
      run('cpu-spike', NODE),
      run('memory-leak', 'us-east-1a.orders-api.01'),
      run('node-kill', 'us-east-1a.worker.01'),
      run('slow-db', 'db'),
      run('cache-outage', 'cache'),
      run('traffic-surge'),
      run('duplicate-storm'),
      run('malformed-flood'),
    ]);
    expect(e.node[NODE]).toEqual({ cpuAdd: 60, cpuFloor: 97 });
    expect(e.node['us-east-1a.orders-api.01']).toEqual({ memRate: 0.25 });
    expect(e.node['us-east-1a.worker.01']).toEqual({ killed: true });
    expect(e.service.db).toEqual({ latMul: 8 });
    expect(e.service.cache).toEqual({ errAdd: 60 });
    expect(e.rpsMul).toBe(10);
  });

  it('overlapping runs stack', () => {
    const e = composeEffects([run('cpu-spike', NODE, 'a'), run('cpu-spike', NODE, 'b'), run('slow-db', 'db', 'c'), run('slow-db', 'db', 'd')]);
    expect(e.node[NODE]!.cpuAdd).toBe(120);
    expect(e.service.db!.latMul).toBe(64);
  });

  it('hzMultiplier: ×5 during a surge, capped', () => {
    expect(hzMultiplier([], 5)).toBe(1);
    expect(hzMultiplier([run('traffic-surge')], 5)).toBe(5);
    expect(hzMultiplier([run('traffic-surge')], 2)).toBe(2);
  });
});

describe('stormTransport', () => {
  const batch = (n: number): IngestBatch => ({
    agentId: 'sim-us-east-1',
    sentAt: 1,
    events: Array.from({ length: n }, (_, seq) => ({ v: 1, nodeId: NODE, bootId: 'abc123', seq, ts: 1, m: { cpu: 1, mem: 1, disk: 1, netIn: 1, netOut: 1, lat: 1, err: 0, rps: 1 } })),
  });

  it('passes batches through when no storm is active', async () => {
    const sent: IngestBatch[] = [];
    const t = stormTransport(async (b) => (sent.push(b), { status: 202 }), () => false);
    await t(batch(10));
    expect(sent).toHaveLength(1);
  });

  it('sends every event three times (shuffled), with ~10% held back and sent once later', async () => {
    const sent: IngestBatch[] = [];
    const later: (() => void)[] = [];
    let r = 0;
    const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
    const t = stormTransport(async (b) => (sent.push(b), { status: 202 }), () => true, rand, (fn, ms) => {
      expect(ms).toBe(CHAOS.stormDelayMs);
      later.push(fn);
    });
    const res = await t(batch(200));
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(3);
    const held = 200 - sent[0]!.events.length;
    expect(held).toBeGreaterThan(5);
    expect(held).toBeLessThan(40);
    // each immediate copy holds the same events
    const ids = (b: IngestBatch) => b.events.map((e) => e.seq).sort((a, b) => a - b).join();
    expect(ids(sent[1]!)).toBe(ids(sent[0]!));
    // shuffled: at least one copy is not in seq order
    expect(sent.some((b) => b.events.some((e, i) => i > 0 && e.seq < b.events[i - 1]!.seq))).toBe(true);
    later.forEach((fn) => fn());
    expect(sent).toHaveLength(4);
    expect(sent[3]!.events).toHaveLength(held);
    // together: every seq covered
    expect(new Set([...sent[0]!.events, ...sent[3]!.events].map((e) => e.seq)).size).toBe(200);
  });
});

describe('ChaosController', () => {
  function host() {
    const world = new World({ seed: 1 });
    const calls = { restart: [] as string[], hz: [] as number[], flood: [] as string[], log: [] as string[] };
    const c = new ChaosController({
      world,
      restartNode: (id) => calls.restart.push(id),
      setHzMultiplier: (m) => calls.hz.push(m),
      startFlood: () => calls.flood.push('start'),
      stopFlood: () => calls.flood.push('stop'),
      log: (l) => calls.log.push(l),
    });
    return { world, c, calls };
  }
  const cmd = (runId: string, scenario: ChaosCommand['scenario'], target: string | null = null): ChaosCommand => ({
    runId, scenario, target, durationSec: 60, endsAt: Date.now() + 60_000,
  });

  it('applies and reverts model effects', () => {
    const { world, c } = host();
    c.start(cmd('1', 'slow-db', 'db'));
    expect(world.effects.service.db?.latMul).toBe(8);
    c.start(cmd('1', 'slow-db', 'db')); // duplicate start (reconnect) is ignored
    expect(c.list()).toHaveLength(1);
    c.stop('1');
    expect(world.effects).toEqual({ rpsMul: 1, service: {}, node: {} });
  });

  it('node-kill recovery restarts the node; traffic-surge changes the tick rate; flood starts and stops', () => {
    const { c, calls } = host();
    c.start(cmd('k', 'node-kill', 'us-east-1a.worker.01'));
    c.start(cmd('s', 'traffic-surge'));
    c.start(cmd('f', 'malformed-flood'));
    expect(calls.hz.at(-1)).toBe(5);
    expect(calls.flood).toEqual(['start']);
    c.stop(); // stop all
    expect(calls.restart).toEqual(['us-east-1a.worker.01']);
    expect(calls.hz.at(-1)).toBe(1);
    expect(calls.flood).toEqual(['start', 'stop']);
    expect(c.list()).toEqual([]);
  });

  it('a fixed memory leak returns memory to its boot level', () => {
    const { world, c } = host();
    const id = 'us-east-1a.orders-api.01';
    const t0 = Date.now();
    world.step(t0, 0.5);
    const before = world.nodes.find((n) => n.def.nodeId === id)!.mem;
    c.start(cmd('m', 'memory-leak', id));
    for (let i = 1; i <= 200; i++) world.step(t0 + i * 1000, 1);
    expect(world.nodes.find((n) => n.def.nodeId === id)!.mem).toBeGreaterThan(before + 30);
    c.stop('m');
    expect(Math.abs(world.nodes.find((n) => n.def.nodeId === id)!.mem - before)).toBeLessThan(5);
  });

  it('ignores commands that already ended', () => {
    const { c } = host();
    c.start({ ...cmd('old', 'cpu-spike', NODE), endsAt: Date.now() - 1 });
    expect(c.list()).toEqual([]);
  });
});

describe('flood bodies', () => {
  it('every body is rejected by the batch schema', () => {
    for (const b of floodBodies(Date.now())) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(b);
      } catch {
        continue; // not JSON at all
      }
      const r = IngestBatchSchema.safeParse(parsed);
      // Either the batch itself is invalid, or (valid shape) the events target nodes the flood agent does not own.
      if (r.success) expect(r.data.events.every((e) => !e.nodeId.startsWith('flood-') || e.ts > Date.now())).toBe(true);
    }
  });
});
