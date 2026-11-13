import { describe, expect, it } from 'vitest';
import { EDGES, SERVICES } from '@epicenter/shared';
import { edgeId, edgeWidth, incidentView, layoutLayers } from './topologyView';

const services = SERVICES.map((s) => ({ id: s.id, layer: s.layer, dependsOn: s.dependsOn.map((d) => d.service) }));
const edges = EDGES.map((e) => ({ from: e.from, to: e.to }));

function crossings(placed: { id: string; x: number; y: number }[]): number {
  const pos = new Map(placed.map((p) => [p.id, p]));
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = [edges[i]!, edges[j]!];
      const [a1, a2, b1, b2] = [pos.get(a.from)!, pos.get(a.to)!, pos.get(b.from)!, pos.get(b.to)!];
      // Only edges spanning the same pair of rows can cross in a layered drawing.
      if (a1.y !== b1.y || a2.y !== b2.y) continue;
      if ((a1.x - b1.x) * (a2.x - b2.x) < 0) n++;
    }
  }
  return n;
}

describe('topology layout', () => {
  it('puts every service on its layer, callers above callees, with no overlaps', () => {
    const placed = layoutLayers(services);
    expect(placed).toHaveLength(SERVICES.length);
    const pos = new Map(placed.map((p) => [p.id, p]));
    for (const s of SERVICES) expect(pos.get(s.id)!.y).toBe(s.layer * 160);
    for (const e of EDGES) expect(pos.get(e.from)!.y).toBeLessThan(pos.get(e.to)!.y);
    const keys = placed.map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('orders rows by their callers, crossing fewer edges than the declaration order', () => {
    const naive = services.map((s) => {
      const row = services.filter((r) => r.layer === s.layer);
      return { id: s.id, x: row.indexOf(s) * 220, y: s.layer * 160 };
    });
    expect(crossings(layoutLayers(services))).toBeLessThanOrEqual(crossings(naive));
    expect(crossings(layoutLayers(services))).toBeLessThanOrEqual(3);
  });
});

describe('incident view', () => {
  it('marks a db fault: blast radius and the edges the failure spreads along', () => {
    const v = incidentView({ epicenter: 'db', blastRadius: ['auth', 'catalog-api', 'orders-api', 'worker', 'edge-gateway'], affected: ['db', 'orders-api'] }, edges);
    expect(v.epicenter).toBe('db');
    expect([...v.blast].sort()).toEqual(['auth', 'catalog-api', 'edge-gateway', 'orders-api', 'worker']);
    expect(v.spreadEdges.has(edgeId('orders-api', 'db'))).toBe(true);
    expect(v.spreadEdges.has(edgeId('edge-gateway', 'auth'))).toBe(true);
    expect(v.spreadEdges.has(edgeId('orders-api', 'payments'))).toBe(false); // payments is not on the path
    expect(v.spreadEdges.has(edgeId('auth', 'cache'))).toBe(false);
  });

  it('derives the blast radius from the graph when the server leaves it empty', () => {
    const v = incidentView({ epicenter: 'cache', blastRadius: [], affected: ['cache'] }, edges);
    expect([...v.blast].sort()).toEqual(['auth', 'catalog-api', 'edge-gateway']);
  });

  it('is empty without an incident or before the epicenter is known', () => {
    expect(incidentView(null, edges).spreadEdges.size).toBe(0);
    const v = incidentView({ epicenter: null, blastRadius: [], affected: ['db'] }, edges);
    expect([v.epicenter, v.blast.size, [...v.affected]]).toEqual([null, 0, ['db']]);
  });
});

describe('edge width', () => {
  it('grows with traffic, capped, with a visible minimum', () => {
    expect(edgeWidth(0, 100)).toBe(1.25);
    expect(edgeWidth(100, 100)).toBe(6);
    expect(edgeWidth(500, 100)).toBe(6);
    expect(edgeWidth(25, 100)).toBeCloseTo(1.25 + 4.75 * 0.5);
  });
});
