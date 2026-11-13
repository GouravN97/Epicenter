import { describe, expect, it } from 'vitest';
import { buildFleet } from '@epicenter/shared';
import { createPipeline } from './index';
import { ingestEvents } from './ingest';

const NOW = 1_700_000_000_000;
const NODE = buildFleet().find((n) => n.region === 'us-east-1')!.nodeId;
const M = { cpu: 10, mem: 20, disk: 30, netIn: 1, netOut: 2, lat: 3, err: 0, rps: 5 };
const ev = (seq: number, over: Record<string, unknown> = {}) => ({ v: 1, nodeId: NODE, bootId: 'abc123', seq, ts: NOW - 100, m: M, ...over });

describe('ingestEvents', () => {
  it('counts accepted, duplicate and late, and leaves valid events of a partly bad batch accepted', () => {
    const p = createPipeline();
    const r = ingestEvents(p, [ev(2), ev(1), ev(2), { junk: true }, ev(3, { m: { ...M, cpu: 'x' } })], 'us-east-1', NOW);
    expect(r).toMatchObject({ accepted: 2, duplicate: 1, late: 1, rejected: 2, reasons: { schema: 2 } });
    expect(p.counters.cur).toMatchObject({ accepted: 2, duplicate: 1, outOfOrder: 1, rejected: 2 });
  });

  it('sending the same batch twice accepts nothing the second time', () => {
    const p = createPipeline();
    const batch = Array.from({ length: 20 }, (_, i) => ev(i));
    expect(ingestEvents(p, batch, 'us-east-1', NOW).accepted).toBe(20);
    expect(ingestEvents(p, batch, 'us-east-1', NOW)).toMatchObject({ accepted: 0, duplicate: 20 });
  });

  it('rejects by time window, ownership and unknown topology', () => {
    const p = createPipeline();
    const r = ingestEvents(
      p,
      [
        ev(1, { ts: NOW + 6_000 }),
        ev(2, { ts: NOW - 61_000 }),
        ev(3, { nodeId: 'eu-west-1a.db.01' }),
        ev(4, { nodeId: 'us-east-1a.nosuchservice.01' }),
        ev(5, { nodeId: 'us-east-1-bogus' }),
      ],
      'us-east-1',
      NOW,
    );
    expect(r.accepted).toBe(0);
    expect(r.reasons).toEqual({ future: 1, too_old: 1, not_owned: 1, unknown_node: 2 });
  });

  it('registers a new canonical node with the next nodeIdx and queues it for persistence', () => {
    const p = createPipeline();
    const id = 'us-east-1c.cache.77';
    const r = ingestEvents(p, [ev(0, { nodeId: id })], 'us-east-1', NOW);
    expect(r.accepted).toBe(1);
    expect(p.registry.get(id)).toMatchObject({ idx: buildFleet().length, serviceId: 'cache', team: 'data' });
    expect(p.registry.takePending().map((n) => n.nodeId)).toEqual([id]);
  });

  it('keeps seeded fleet order for nodeIdx, then DB-known extra nodes', () => {
    const fleet = buildFleet();
    const p = createPipeline(['us-east-1a.worker.99', fleet[3]!.nodeId]);
    expect(p.registry.get(fleet[0]!.nodeId)!.idx).toBe(0);
    expect(p.registry.get(fleet[47]!.nodeId)!.idx).toBe(47);
    expect(p.registry.get('us-east-1a.worker.99')!.idx).toBe(48);
    expect(p.registry.takePending()).toEqual([]);
  });

  it('a late event for an already-finalized bucket counts as late and lateCorrected', () => {
    const p = createPipeline();
    ingestEvents(p, [ev(5, { ts: NOW - 4_000 })], 'us-east-1', NOW - 3_900);
    p.aggregator.tick(NOW);
    const r = ingestEvents(p, [ev(6, { ts: NOW - 3_950 })], 'us-east-1', NOW);
    expect(r).toMatchObject({ accepted: 1, late: 1 });
    expect(p.counters.cur.lateCorrected).toBe(1);
    expect(p.state.nodes.get(NODE)!.point).toMatchObject({ rev: 0 });
  });
});
