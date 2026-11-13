import { describe, expect, it } from 'vitest';
import {
  IngestBatchEnvelopeSchema,
  METRICS,
  NODE_PT_METRIC0,
  ReplayQuerySchema,
  SERVICES,
  TelemetryEventSchema,
  buildFleet,
  encodeNodePt,
  parseNodeId,
  parseRoom,
  room,
  transitiveDependents,
  transitiveDeps,
} from './index';

describe('topology', () => {
  it('builds 48 unique, valid nodes spread over 3 regions', () => {
    const fleet = buildFleet();
    expect(fleet).toHaveLength(48);
    expect(new Set(fleet.map((n) => n.nodeId)).size).toBe(48);
    expect(new Set(fleet.map((n) => n.region)).size).toBe(3);
    for (const n of fleet) {
      expect(TelemetryEventSchema.shape.nodeId.safeParse(n.nodeId).success).toBe(true);
      expect(parseNodeId(n.nodeId)).toMatchObject({ serviceId: n.serviceId, az: n.az, region: n.region });
    }
  });

  it('matches the plan’s example id format', () => {
    expect(parseNodeId('ap-south-1a.orders-api.03')).toEqual({
      region: 'ap-south-1', az: 'ap-south-1a', serviceId: 'orders-api', index: 3,
    });
  });

  it('is acyclic and indexes services by position', () => {
    SERVICES.forEach((s, i) => {
      expect(s.idx).toBe(i);
      expect(transitiveDeps(s.id).has(s.id)).toBe(false);
    });
  });

  it('gives the blast radius the plan expects for db and cache faults', () => {
    expect([...transitiveDependents('db')].sort()).toEqual(
      ['auth', 'catalog-api', 'edge-gateway', 'orders-api', 'worker'].sort(),
    );
    expect([...transitiveDependents('cache')].sort()).toEqual(['auth', 'catalog-api', 'edge-gateway'].sort());
    expect(transitiveDependents('edge-gateway').size).toBe(0);
  });
});

describe('schemas', () => {
  const ev = {
    v: 1, nodeId: 'us-east-1a.db.01', bootId: 'abc123', seq: 0, ts: Date.now(),
    m: { cpu: 120, mem: 40, disk: 30, netIn: 1, netOut: 2, lat: 3, err: -1, rps: 10 },
  };

  it('clamps percent metrics', () => {
    const r = TelemetryEventSchema.parse(ev);
    expect(r.m.cpu).toBe(100);
    expect(r.m.err).toBe(0);
  });

  it('rejects non-finite values, bad ids and negative seq', () => {
    expect(TelemetryEventSchema.safeParse({ ...ev, m: { ...ev.m, lat: Infinity } }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...ev, nodeId: 'Bad_ID' }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...ev, seq: -1 }).success).toBe(false);
  });

  it('envelope accepts a batch with a bad event and caps size', () => {
    expect(IngestBatchEnvelopeSchema.safeParse({ agentId: 'a', sentAt: 1, events: [ev, { junk: 1 }] }).success).toBe(true);
    expect(IngestBatchEnvelopeSchema.safeParse({ agentId: 'a', sentAt: 1, events: Array(501).fill(ev) }).success).toBe(false);
  });

  it('parses replay service lists', () => {
    expect(ReplayQuerySchema.parse({ from: '1', to: '2', services: 'db,cache' }).services).toEqual(['db', 'cache']);
    expect(ReplayQuerySchema.safeParse({ from: '1', to: '2', services: 'nope' }).success).toBe(false);
  });
});

describe('wire', () => {
  it('round-trips room names', () => {
    expect(parseRoom(room.fleet('payments'))).toEqual({ kind: 'fleet', arg: 'payments' });
    expect(parseRoom(room.node('us-east-1a.db.01'))).toEqual({ kind: 'node', arg: 'us-east-1a.db.01' });
    expect(parseRoom('topology')).toEqual({ kind: 'topology', arg: '' });
    expect(parseRoom('bogus:x')).toBeNull();
    expect(parseRoom('node:')).toBeNull();
  });

  it('lays node:pt metrics out in METRICS order', () => {
    const m = Object.fromEntries(METRICS.map((k, i) => [k, i + 0.04])) as Record<(typeof METRICS)[number], number>;
    const pt = encodeNodePt(7, 1000, m, 2);
    expect(pt).toHaveLength(11);
    METRICS.forEach((_, i) => expect(pt[NODE_PT_METRIC0 + i]).toBe(i));
    expect(pt[10]).toBe(2);
  });
});
