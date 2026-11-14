// Fleet heatmap (plan §9.3): one <canvas>, a hexagon per node grouped under its service.
//   fill    = CPU, five steps of one blue ramp; idle is the step nearest the surface, so it recedes
//             (dark on a dark surface, pale on a light one), and hot is the step furthest from it
//   outline = status (amber warning, red critical with a centre mark), stripes = silent
// The canvas is drawn from the fleet typed arrays inside the shared animation-frame loop, so a
// fleet:delta costs no React work. Hover and tooltip are handled imperatively for the same reason.
import { hotkey } from '../lib/shortcuts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NodeStatus, SERVICES, SERVICE_BY_ID, isServiceId, type TopologyResponse } from '@epicenter/shared';
import { FLEET_KEY, fleet as liveFleet, store, topology } from '../data/live';
import type { FleetState } from '../data/fleetState';
import { CPU_BUCKET_LABELS, LABEL_H, cpuBucket, hitTest, layoutHeatmap, neighbour, type Direction, type HeatGroupInput, type HeatLayout, type HexCell } from '../lib/heatmapLayout';
import { useAppearance } from '../state/displayStore';
import { STATUS_VIEW, StatusIcon } from './StatusIcon';

interface Palette {
  heat: string[];
  surface: string;
  raised: string;
  line: string;
  fg: string;
  muted: string;
  faint: string;
  warn: string;
  crit: string;
  silent: string;
  font: string;
}

function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    heat: [1, 2, 3, 4, 5].map((i) => v(`--color-heat-${i}`)),
    surface: v('--color-surface'),
    raised: v('--color-raised'),
    line: v('--color-line'),
    fg: v('--color-fg'),
    muted: v('--color-muted'),
    faint: v('--color-faint'),
    warn: v('--color-warn'),
    crit: v('--color-crit'),
    silent: v('--color-silent'),
    font: v('--font-sans'),
  };
}

/** Diagonal stripes for silent nodes: a texture, so the state does not depend on colour. */
function stripePattern(ctx: CanvasRenderingContext2D, p: Palette, dpr: number): CanvasPattern | null {
  const size = Math.round(6 * dpr);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = p.raised;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = p.silent;
  g.lineWidth = Math.max(1, 1.5 * dpr);
  g.beginPath();
  for (const o of [-size, 0, size]) {
    g.moveTo(o, size);
    g.lineTo(o + size, 0);
  }
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}

function hexPath(path: Path2D, x: number, y: number, r: number): void {
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k - Math.PI / 2; // pointy-top
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (k === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  }
  path.closePath();
}

function groupsOf(t: TopologyResponse): HeatGroupInput[] {
  return SERVICES.map((s) => ({
    id: s.id,
    name: s.name,
    nodes: t.nodes.filter((n) => n[2] === s.id).map((n) => n[0]),
  })).filter((g) => g.nodes.length > 0);
}

export interface FleetHeatmapProps {
  topology: TopologyResponse;
  /** State to draw. Defaults to the live fleet; the incident replay passes its recorded state. */
  state?: FleetState;
  /** Store key whose dirty flag triggers a redraw. Defaults to the live fleet's key. */
  drawKey?: string;
}

export function FleetHeatmap({ topology: topo, state = liveFleet, drawKey = FLEET_KEY }: FleetHeatmapProps) {
  const navigate = useNavigate();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const announceRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The palette is read from the theme when the drawer is set up: set it up again when the theme changes.
  const appearance = useAppearance().key;

  const groups = useMemo(() => groupsOf(topo), [topo]);
  const layout = useMemo<HeatLayout | null>(() => (width > 0 ? layoutHeatmap(groups, width) : null), [groups, width]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const tip = tipRef.current;
    const announce = announceRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !tip || !announce || !ctx || !layout) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(layout.width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    canvas.style.height = `${layout.height}px`;
    const palette = readPalette(canvas);
    const stripes = stripePattern(ctx, palette, dpr);
    const r = layout.r - 1; // 2 px of surface between neighbouring fills
    let hovered: HexCell | null = null;
    let touchArmed = -1;

    const tipField = (name: string) => tip.querySelector<HTMLElement>(`[data-f="${name}"]`)!;
    const showTip = () => {
      if (!hovered) {
        tip.hidden = true;
        return;
      }
      const i = hovered.nodeIdx;
      const node = topology.nodeByIdx[i];
      const seen = state.seen[i] === 1;
      const status = seen ? state.status[i]! : -1;
      tipField('id').textContent = node?.[1] ?? `node ${i}`;
      const svc = node && isServiceId(node[2]) ? SERVICE_BY_ID[node[2]].name : (node?.[2] ?? '');
      tipField('where').textContent = node ? `${svc} · ${node[4]}` : '';
      tipField('cpu').textContent = seen ? `${state.cpu[i]}%` : '–';
      tipField('mem').textContent = seen ? `${state.mem[i]}%` : '–';
      tipField('nodata').hidden = seen;
      for (const el of tip.querySelectorAll<HTMLElement>('[data-status]')) el.hidden = Number(el.dataset.status) !== status;
      tip.hidden = false;
      // Keep the tooltip inside the panel: flip to the left of the cell near the right edge.
      const tw = tip.offsetWidth;
      const left = hovered.x + layout.r + 8 + tw > layout.width ? hovered.x - layout.r - 8 - tw : hovered.x + layout.r + 8;
      tip.style.transform = `translate(${Math.max(0, Math.round(left))}px, ${Math.round(Math.max(0, hovered.y - 20))}px)`;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, layout.width, layout.height);

      ctx.textBaseline = 'middle';
      for (const g of layout.groups) {
        ctx.font = `500 12px ${palette.font}`;
        ctx.fillStyle = palette.muted;
        ctx.fillText(g.name, g.x, g.y + LABEL_H / 2 - 2);
        const nameW = ctx.measureText(g.name).width;
        ctx.font = `12px ${palette.font}`;
        ctx.fillStyle = palette.faint;
        ctx.fillText(String(g.count), g.x + nameW + 6, g.y + LABEL_H / 2 - 2);
      }

      // One path per fill, so the whole fleet is a handful of fill calls however many nodes there are.
      const heat = palette.heat.map(() => new Path2D());
      const unseen = new Path2D();
      const silent = new Path2D();
      const warn = new Path2D();
      const crit = new Path2D();
      const critMark = new Path2D();
      for (const c of layout.cells) {
        const i = c.nodeIdx;
        if (!state.seen[i]) {
          hexPath(unseen, c.x, c.y, r);
          continue;
        }
        const st = state.status[i]!;
        if (st === NodeStatus.silent) {
          hexPath(silent, c.x, c.y, r);
          continue;
        }
        hexPath(heat[cpuBucket(state.cpu[i]!)]!, c.x, c.y, r);
        if (st === NodeStatus.warn) hexPath(warn, c.x, c.y, r - 1);
        else if (st === NodeStatus.crit) {
          hexPath(crit, c.x, c.y, r - 1);
          critMark.moveTo(c.x + r * 0.3, c.y);
          critMark.arc(c.x, c.y, r * 0.3, 0, Math.PI * 2);
        }
      }
      heat.forEach((path, b) => {
        ctx.fillStyle = palette.heat[b]!;
        ctx.fill(path);
      });
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.line;
      ctx.stroke(unseen);
      if (stripes) {
        ctx.fillStyle = stripes;
        ctx.fill(silent);
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = palette.silent;
      ctx.stroke(silent);
      ctx.lineWidth = 2;
      ctx.strokeStyle = palette.warn;
      ctx.stroke(warn);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = palette.crit;
      ctx.stroke(crit);
      // Critical also carries a centre mark, so it differs from warning by shape as well as hue.
      ctx.fillStyle = palette.crit;
      ctx.fill(critMark);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = palette.surface;
      ctx.stroke(critMark);

      if (hovered) {
        const ring = new Path2D();
        hexPath(ring, hovered.x, hovered.y, r + 1.5);
        ctx.lineWidth = 2;
        ctx.strokeStyle = palette.fg;
        ctx.stroke(ring);
        showTip(); // values under the pointer keep updating while it rests there
      }
    };

    const setHover = (cell: HexCell | null) => {
      if (cell?.nodeIdx === hovered?.nodeIdx) return;
      hovered = cell;
      canvas.style.cursor = cell ? 'pointer' : 'default';
      showTip();
      store.markDirty(drawKey);
    };
    const cellAt = (e: PointerEvent | MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      return hitTest(layout, e.clientX - box.left, e.clientY - box.top);
    };
    const open = (cell: HexCell) => {
      const id = topology.nodeIdByIdx[cell.nodeIdx];
      if (id) navigate(`/node/${encodeURIComponent(id)}`);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHover(cellAt(e));
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHover(null);
    };
    const onUp = (e: PointerEvent) => {
      const cell = cellAt(e);
      if (e.pointerType !== 'touch') {
        if (cell) open(cell);
        return;
      }
      // Touch has no hover: the first tap shows the tooltip, a second tap on the same node opens it.
      if (cell && touchArmed === cell.nodeIdx) open(cell);
      else {
        touchArmed = cell?.nodeIdx ?? -1;
        setHover(cell);
      }
    };

    // Keyboard: Tab focuses the map, arrows move between nodes, Enter opens one. Each move is announced.
    let keyCell: HexCell | null = null;
    const say = (cell: HexCell) => {
      const i = cell.nodeIdx;
      const node = topology.nodeByIdx[i];
      const svc = node && isServiceId(node[2]) ? SERVICE_BY_ID[node[2]].name : '';
      const seen = state.seen[i] === 1;
      const st = seen ? (STATUS_VIEW[state.status[i]!]?.label ?? '') : 'no data yet';
      announce.textContent = `${node?.[1] ?? `node ${i}`}, ${svc}, ${st}${seen ? `, CPU ${state.cpu[i]} percent, memory ${state.mem[i]} percent` : ''}`;
    };
    const focusCell = (cell: HexCell | null) => {
      if (!cell) return;
      keyCell = cell;
      setHover(cell);
      say(cell);
    };
    const KEYS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    const onKey = (e: KeyboardEvent) => {
      const dir = KEYS[e.key];
      if (dir) {
        e.preventDefault();
        focusCell(keyCell ? (neighbour(layout, keyCell, dir) ?? keyCell) : layout.cells[0]!);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        focusCell(e.key === 'Home' ? layout.cells[0]! : layout.cells.at(-1)!);
      } else if ((e.key === 'Enter' || e.key === ' ') && keyCell) {
        e.preventDefault();
        open(keyCell);
      } else if (e.key === 'Escape') {
        setHover(null);
      }
    };
    const onFocus = () => focusCell(keyCell && layout.cells.includes(keyCell) ? keyCell : layout.cells[0]!);
    const onBlur = () => setHover(null);

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('keydown', onKey);
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);
    const drawer = store.addDrawer(drawKey, draw);
    return () => {
      drawer.dispose();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      tip.hidden = true;
    };
  }, [layout, navigate, state, drawKey, appearance]);

  return (
    <div ref={wrapRef} className="relative">
      <canvas
        ref={canvasRef}
        role="application"
        aria-roledescription="heatmap"
        tabIndex={0}
        {...hotkey('f', 'focus')}
        aria-label={`Fleet heatmap: ${topo.nodes.length} nodes grouped by service. Fill shows CPU, outline shows status. Use the arrow keys to move between nodes and Enter to open one.`}
        className="block w-full touch-manipulation rounded-sm"
      />
      <div ref={announceRef} aria-live="polite" className="sr-only" />
      <div
        ref={tipRef}
        hidden
        className="popover pointer-events-none absolute left-0 top-0 z-10 w-max max-w-64 rounded-md px-3 py-2 text-xs"
      >
        <div data-f="id" className="metric text-fg" />
        <div data-f="where" className="mt-0.5 text-muted" />
        <div className="mt-1.5 flex items-center gap-1.5">
          {STATUS_VIEW.map((s, i) => (
            <span key={s.name} data-status={i} hidden className="inline-flex items-center gap-1.5 text-fg">
              <StatusIcon status={i} className="size-3.5" />
              {s.label}
            </span>
          ))}
          <span data-f="nodata" hidden className="text-muted">
            No data yet
          </span>
        </div>
        <div className="mt-1.5 flex gap-4 text-muted">
          <span>
            CPU <span data-f="cpu" className="metric text-fg" />
          </span>
          <span>
            Mem <span data-f="mem" className="metric text-fg" />
          </span>
        </div>
      </div>
    </div>
  );
}

/** CPU scale and status counts. `counts` is [ok, warn, crit, silent], refreshed by the parent at 1 Hz. */
export function HeatmapLegend({ counts }: { counts: readonly number[] }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-muted">
      <div className="flex items-start gap-2.5">
        <span className="leading-[10px]">CPU %</span>
        <div className="flex gap-0.5">
          {CPU_BUCKET_LABELS.map((label, i) => (
            <div key={label} className="text-center">
              <div className="h-2.5 w-11 rounded-sm" style={{ background: `var(--color-heat-${i + 1})` }} />
              <div className="metric mt-1 text-micro text-faint">{label}</div>
            </div>
          ))}
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {STATUS_VIEW.map((s, i) => (
          <li key={s.name} className="inline-flex items-center gap-1.5">
            <StatusIcon status={i} className="size-3.5" />
            {s.label}
            <span className="metric text-fg">{counts[i] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
