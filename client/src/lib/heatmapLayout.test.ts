import { describe, expect, it } from 'vitest';
import { cpuBucket, hitTest, layoutHeatmap, neighbour, type HeatGroupInput } from './heatmapLayout';

function fleetOf(counts: number[]): HeatGroupInput[] {
  let idx = 0;
  return counts.map((n, g) => ({ id: `svc-${g}`, name: `Service ${g}`, nodes: Array.from({ length: n }, () => idx++) }));
}
const SEED = [6, 4, 6, 6, 4, 10, 4, 4, 4];

describe('heatmap layout', () => {
  it('places every node once, inside the canvas, without overlaps', () => {
    for (const [groups, width] of [
      [fleetOf(SEED), 820],
      [fleetOf(SEED), 326], // phone
      [fleetOf(SEED.map((n) => n * 10)), 820], // ~500 nodes
    ] as const) {
      const l = layoutHeatmap(groups, width);
      const total = groups.reduce((n, g) => n + g.nodes.length, 0);
      expect(l.cells).toHaveLength(total);
      expect(new Set(l.cells.map((c) => c.nodeIdx)).size).toBe(total);
      for (const c of l.cells) {
        const half = (Math.sqrt(3) / 2) * l.r; // a pointy-top hexagon is √3·r wide
        expect(c.x - half).toBeGreaterThanOrEqual(-0.01);
        expect(c.x + half).toBeLessThanOrEqual(width + 0.01);
        expect(c.y + l.r).toBeLessThanOrEqual(l.height + 0.01);
      }
      // Nearest two centres are at least one hexagon width apart.
      let min = Infinity;
      for (let i = 0; i < l.cells.length; i++) {
        for (let j = i + 1; j < l.cells.length; j++) {
          min = Math.min(min, Math.hypot(l.cells[i]!.x - l.cells[j]!.x, l.cells[i]!.y - l.cells[j]!.y));
        }
      }
      expect(min).toBeGreaterThanOrEqual(Math.sqrt(3) * l.r - 0.01);
    }
  });

  it('shrinks the hexagons for a large fleet and skips empty groups', () => {
    const small = layoutHeatmap(fleetOf(SEED), 820);
    const large = layoutHeatmap(fleetOf(SEED.map((n) => n * 10)), 820);
    expect(small.r).toBe(16);
    expect(large.r).toBeLessThan(small.r);
    expect(layoutHeatmap(fleetOf([3, 0, 2]), 400).groups.map((g) => g.id)).toEqual(['svc-0', 'svc-2']);
  });

  it('hit-tests a hexagon centre and misses empty space', () => {
    const l = layoutHeatmap(fleetOf(SEED), 820);
    const c = l.cells[17]!;
    expect(hitTest(l, c.x + 2, c.y - 2)?.nodeIdx).toBe(c.nodeIdx);
    expect(hitTest(l, c.x, 2)).toBeNull(); // the label strip
  });

  it('buckets CPU into five steps', () => {
    expect([0, 19.9, 20, 59, 80, 100, 140, -5].map(cpuBucket)).toEqual([0, 0, 1, 2, 4, 4, 4, 0]);
  });
});

describe('heatmap keyboard navigation', () => {
  it('reaches every node with the right arrow alone, in reading order', () => {
    const l = layoutHeatmap(fleetOf(SEED), 820);
    let c = l.cells[0]!;
    const seen = [c.nodeIdx];
    for (let k = 0; k < l.cells.length + 5; k++) {
      const n = neighbour(l, c, 'right');
      if (!n) break;
      seen.push(n.nodeIdx);
      c = n;
    }
    expect(seen).toEqual(l.cells.map((x) => x.nodeIdx));
    expect(neighbour(l, l.cells.at(-1)!, 'right')).toBeNull();
    expect(neighbour(l, l.cells[0]!, 'left')).toBeNull();
  });

  it('moves up and down between rows and back again', () => {
    const l = layoutHeatmap(fleetOf(SEED), 820);
    const top = l.cells[0]!;
    const down = neighbour(l, top, 'down')!;
    expect(down.y).toBeGreaterThan(top.y);
    expect(neighbour(l, down, 'up')!.y).toBe(top.y);
    expect(neighbour(l, top, 'up')).toBeNull();
  });
});
