// Layout for the fleet heatmap: hexagons grouped under service labels, flowing left to right and
// wrapping. Pure geometry, so it is testable and the canvas component only draws.

export interface HeatGroupInput {
  id: string;
  name: string;
  /** nodeIdx of each node in the group, in display order. */
  nodes: number[];
}

export interface HexCell {
  nodeIdx: number;
  /** Centre, CSS px. */
  x: number;
  y: number;
}

export interface HeatGroup {
  id: string;
  name: string;
  count: number;
  /** Top-left of the group's label. */
  x: number;
  y: number;
  width: number;
}

export interface HeatLayout {
  /** Hexagon circumradius (centre to corner), CSS px. */
  r: number;
  width: number;
  height: number;
  cells: HexCell[];
  groups: HeatGroup[];
}

export const LABEL_H = 22;
const GAP_X = 28;
const GAP_Y = 20;
const SIZES = [16, 14, 12, 10, 9, 8, 7, 6];
const SQRT3 = Math.sqrt(3);

function layoutAt(groups: HeatGroupInput[], width: number, r: number): HeatLayout {
  const w = SQRT3 * r; // pointy-top hexagon: column pitch
  const rowPitch = 1.5 * r;
  const maxCols = Math.max(2, Math.floor((width - w / 2) / w));
  const cells: HexCell[] = [];
  const out: HeatGroup[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;

  for (const g of groups) {
    const n = g.nodes.length;
    if (!n) continue;
    // Wider than tall reads best under a one-line label.
    const cols = Math.min(maxCols, Math.max(2, Math.ceil(Math.sqrt(n * 2))));
    const rows = Math.ceil(n / cols);
    // Room for the label text as well as the hexagons, so labels never run into the next group.
    const gw = Math.max(cols * w + (rows > 1 ? w / 2 : 0), Math.min(width, g.name.length * 7 + 34));
    const gh = LABEL_H + rows * rowPitch + r / 2;
    if (x > 0 && x + gw > width) {
      x = 0;
      y += rowH + GAP_Y;
      rowH = 0;
    }
    out.push({ id: g.id, name: g.name, count: n, x, y, width: gw });
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      cells.push({
        nodeIdx: g.nodes[i]!,
        x: x + w / 2 + col * w + (row % 2 ? w / 2 : 0),
        y: y + LABEL_H + r + row * rowPitch,
      });
    }
    x += gw + GAP_X;
    rowH = Math.max(rowH, gh);
  }
  return { r, width, height: y + rowH, cells, groups: out };
}

/** Uses the largest hexagon size whose layout fits `maxHeight`; the smallest size if none does. */
export function layoutHeatmap(groups: HeatGroupInput[], width: number, maxHeight = 460): HeatLayout {
  let layout = layoutAt(groups, width, SIZES[0]!);
  for (const r of SIZES) {
    layout = layoutAt(groups, width, r);
    if (layout.height <= maxHeight) break;
  }
  return layout;
}

/** The cell under (x, y), or null. Hexagons tile, so the nearest centre within r is the one hit. */
export function hitTest(layout: HeatLayout, x: number, y: number): HexCell | null {
  let best: HexCell | null = null;
  let bestD = layout.r * layout.r;
  for (const c of layout.cells) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** CPU % → heat step 0–4 (20-point buckets). */
export const cpuBucket = (cpu: number): number => Math.min(4, Math.max(0, Math.floor(cpu / 20)));
export const CPU_BUCKET_LABELS = ['0–20', '20–40', '40–60', '60–80', '80–100'];

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * The cell keyboard navigation moves to from `from`. Left/right stay in the hexagon row and continue into
 * the previous/next cell in reading order at a row's end (so every node is reachable with arrows alone);
 * up/down pick the nearest cell in that direction, preferring the same column.
 */
export function neighbour(layout: HeatLayout, from: HexCell, dir: Direction): HexCell | null {
  const cells = layout.cells;
  const rowTol = layout.r * 0.5;
  let best: HexCell | null = null;
  let bestScore = Infinity;
  for (const c of cells) {
    if (c === from) continue;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    let along: number;
    let across: number;
    if (dir === 'right' || dir === 'left') {
      if (Math.abs(dy) > rowTol || (dir === 'right' ? dx <= 1 : dx >= -1)) continue;
      along = Math.abs(dx);
      across = Math.abs(dy);
    } else {
      if (dir === 'down' ? dy <= 1 : dy >= -1) continue;
      along = Math.abs(dy);
      across = Math.abs(dx);
    }
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // A gap wider than one hexagon means the next group: for left/right, fall back to reading order instead.
  const w = Math.sqrt(3) * layout.r;
  if ((dir === 'left' || dir === 'right') && (!best || Math.abs(best.x - from.x) > 1.6 * w)) {
    const i = cells.indexOf(from);
    return cells[dir === 'right' ? i + 1 : i - 1] ?? null;
  }
  return best;
}
