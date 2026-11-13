// The whole recorded window for one service metric, with a cursor at the replay position. Clicking the
// chart seeks there. The cursor is drawn in a uPlot hook from the clock, redrawn by the replay loop.
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { clock, store } from '../data/live';
import { clockTime, compact } from '../lib/format';
import { timeSplits } from './LiveChart';

export interface ReplayChartProps {
  t: number[];
  series: { label: string; values: (number | null)[]; colorVar: string }[];
  unit: string;
  /** Store key the replay loop marks dirty to move the cursor. */
  drawKey: string;
  /** Alert onsets, drawn as faint verticals. */
  markers: number[];
  onSeek(t: number): void;
  ariaLabel: string;
}

const fmt = (v: number) => (Math.abs(v) >= 100 ? compact(v) : String(Math.round(v * 10) / 10));

export function ReplayChart(props: ReplayChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const cfg = useRef(props);
  cfg.current = props;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const font = `11px ${v('--font-sans')}`;
    const { t, series, unit, markers } = cfg.current;

    const u = new uPlot(
      {
        width: Math.max(120, el.clientWidth),
        height: 200,
        ms: 1,
        cursor: { drag: { x: false, y: false }, points: { size: 7 } },
        legend: { show: true, live: true },
        scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, Math.max(1, (max ?? 1) * 1.1)] } },
        axes: [
          {
            stroke: v('--color-muted'),
            font,
            size: 28,
            grid: { show: false },
            ticks: { stroke: v('--color-line'), size: 4 },
            splits: (u, _i, min, max) => timeSplits(min, max, u.bbox.width / devicePixelRatio),
            // Seconds matter in a window of a few minutes; drop them once ticks are a minute or more apart.
            values: (_u, s) => s.map((x, i) => (i > 0 && s[i]! - s[i - 1]! >= 60_000 ? clockTime(x).slice(0, 5) : clockTime(x))),
          },
          { stroke: v('--color-muted'), font, size: 42, grid: { stroke: v('--color-line'), width: 1 }, ticks: { show: false }, values: (_u, s) => s.map(fmt) },
        ],
        series: [
          { label: 'Time', value: (_u, x) => (x == null ? '–' : clockTime(x)) },
          ...series.map((s) => ({
            label: s.label,
            stroke: v(s.colorVar),
            width: 2,
            points: { show: false },
            value: (_u: uPlot, val: number | null) => (val == null ? '–' : `${fmt(val)} ${unit}`),
          })),
        ],
        hooks: {
          draw: [
            (u) => {
              const { ctx, bbox } = u;
              const line = (x: number, color: string, w: number, dash: number[]) => {
                const px = u.valToPos(x, 'x', true);
                if (px < bbox.left || px > bbox.left + bbox.width) return;
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = w * devicePixelRatio;
                ctx.setLineDash(dash.map((d) => d * devicePixelRatio));
                ctx.beginPath();
                ctx.moveTo(px, bbox.top);
                ctx.lineTo(px, bbox.top + bbox.height);
                ctx.stroke();
                ctx.restore();
              };
              for (const m of markers) line(m, v('--color-faint'), 1, [2, 3]);
              if (clock.mode === 'replay') line(clock.now(), v('--color-fg'), 1.5, []);
            },
          ],
        },
      },
      [t, ...series.map((s) => s.values)] as uPlot.AlignedData,
      el,
    );

    const onClick = (e: MouseEvent) => {
      const box = u.over.getBoundingClientRect();
      cfg.current.onSeek(Math.round(u.posToVal(e.clientX - box.left, 'x') / 1000) * 1000);
    };
    u.over.addEventListener('click', onClick);
    u.over.style.cursor = 'pointer';
    const ro = new ResizeObserver(([e]) => {
      const w = Math.floor(e!.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: 200 });
    });
    ro.observe(el);
    const drawer = store.addDrawer(cfg.current.drawKey, () => {
      u.redraw(false, false);
      // With the pointer off the chart, the legend reads the value at the replay position.
      if ((u.cursor.left ?? -1) >= 0 || clock.mode !== 'replay') return;
      const xs = u.data[0]!;
      const target = clock.now();
      let lo = 0;
      let hi = xs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (xs[mid]! < target) lo = mid + 1;
        else hi = mid;
      }
      if (xs.length && u.legend.idx !== lo) u.setLegend({ idx: lo }, false);
    });
    return () => {
      drawer.dispose();
      ro.disconnect();
      u.over.removeEventListener('click', onClick);
      u.destroy();
    };
  }, [props.t, props.series, props.unit, props.markers, props.drawKey]);

  return <div ref={wrap} role="img" aria-label={props.ariaLabel} className="w-full" />;
}
