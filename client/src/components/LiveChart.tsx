// Thin wrapper around uPlot (plan §9.3). The chart is created once and fed from a SeriesBuffer inside
// the shared animation-frame loop: `setData` gets zero-copy views of the buffer, so a new point costs
// one canvas redraw and no React render. Charts with the same `syncKey` share a crosshair.
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { clock, store } from '../data/live';
import type { SeriesBuffer } from '../data/SeriesBuffer';
import { clockTime, compact } from '../lib/format';
import { useAppearance } from '../state/displayStore';

export interface ChartSeries {
  label: string;
  /** Column of the buffer (METRICS order). */
  column: number;
  /** CSS custom property holding the line colour, e.g. "--color-series-1". */
  colorVar: string;
}

export interface ChartGhost {
  buffer: SeriesBuffer;
  /** Store key of the ghost buffer. */
  drawKey: string;
  /** The ghost's points are drawn this much later than their timestamps (1 h for "1 h ago"). */
  offsetMs: number;
  column: number;
}

export interface LiveChartProps {
  buffer: SeriesBuffer;
  /** Store key of `buffer`. */
  drawKey: string;
  series: ChartSeries[];
  /** Visible window: [now − rangeMs, now], where now comes from the app clock. */
  rangeMs: number;
  /** Spacing of the points (1000 or 60000). A wider spacing is drawn as a break, not a straight line. */
  stepMs: number;
  unit: string;
  /** Fixed top of the y axis (100 for percentages). Otherwise it follows the data. */
  yMax?: number;
  /** Smallest y-axis top when it follows the data, so a quiet series is not magnified into noise. */
  yFloor?: number;
  syncKey: string;
  /** Baseline overlay for the first series, drawn dashed. */
  ghost?: ChartGhost | null;
  height?: number;
  ariaLabel: string;
}

/** Next "nice" number ≥ x (1, 2, 2.5, 5 × 10^k). */
function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const fmtValue = (v: number): string => (Math.abs(v) >= 100 ? compact(v) : String(Math.round(v * 10) / 10));

const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000);

/** Time-axis ticks on round local clock times (…:00, …:30), about one per 75 px. */
export function timeSplits(min: number, max: number, widthPx: number): number[] {
  const want = Math.max(2, Math.floor(widthPx / 75));
  const step = TIME_STEPS.find((s) => (max - min) / s <= want) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const tz = new Date(min).getTimezoneOffset() * 60_000; // align in local time: some zones are offset by 30 or 45 min
  const out: number[] = [];
  for (let t = Math.ceil((min - tz) / step) * step + tz; t <= max; t += step) out.push(t);
  return out;
}

export function LiveChart(props: LiveChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Latest props for the draw path, which must not be rebuilt when they change.
  const cfg = useRef(props);
  cfg.current = props;
  const seriesSig = props.series.map((s) => `${s.label}:${s.column}:${s.colorVar}`).join('|');
  // Colours are read from the theme once, when the chart is built: build it again when they change.
  const appearance = useAppearance().key;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const css = getComputedStyle(wrap);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const muted = v('--color-muted');
    const faint = v('--color-faint');
    const line = v('--color-line');
    const font = `11px ${v('--font-sans')}`;
    const { series, unit, yMax, yFloor, syncKey } = cfg.current;

    /** Largest ghost value inside the visible window, so the baseline is never clipped. */
    const ghostMax = (xMin: number, xMax: number): number => {
      const g = cfg.current.ghost;
      if (!g) return 0;
      const t = g.buffer.times();
      const y = g.buffer.column(g.column);
      let max = 0;
      for (let i = 0; i < t.length; i++) {
        const x = t[i]! + g.offsetMs;
        if (x >= xMin && x <= xMax && y[i]! > max) max = y[i]!;
      }
      return max;
    };

    const opts: uPlot.Options = {
      width: Math.max(120, wrap.clientWidth),
      height: cfg.current.height ?? 190,
      ms: 1,
      cursor: { sync: { key: syncKey }, drag: { x: false, y: false }, points: { size: 7 } },
      legend: { show: true, live: true },
      scales: {
        x: { time: true, auto: false },
        y: {
          range: (u, _min, dataMax) => {
            if (yMax !== undefined) return [0, yMax];
            const x = u.scales.x!;
            const top = Math.max(dataMax ?? 0, ghostMax(x.min ?? 0, x.max ?? 0), yFloor ?? 0);
            return [0, niceCeil(top * 1.08)];
          },
        },
      },
      axes: [
        {
          stroke: muted,
          font,
          grid: { show: false },
          ticks: { stroke: line, width: 1, size: 4 },
          size: 28,
          splits: (u, _axisIdx, min, max) => timeSplits(min, max, u.bbox.width / devicePixelRatio),
          // 24-hour clock; seconds only when the window is short enough for them to matter.
          values: (_u, splits) => splits.map((t) => (cfg.current.rangeMs <= 15 * 60_000 ? clockTime(t) : clockTime(t).slice(0, 5))),
        },
        {
          stroke: muted,
          font,
          size: 42,
          grid: { stroke: line, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map(fmtValue),
        },
      ],
      series: [
        { label: 'Time', value: (_u, t) => (t == null ? '–' : clockTime(t)) },
        ...series.map(
          (s): uPlot.Series => ({
            label: s.label,
            stroke: v(s.colorVar),
            width: 2,
            points: { show: false },
            value: (_u, val) => (val == null ? '–' : `${fmtValue(val)} ${unit}`),
            // Break the line where points are missing (a silent node, an unhealed gap) instead of
            // drawing a straight segment that would look like data.
            gaps: (u, _sidx, i0, i1, nullGaps) => {
              const xs = u.data[0]!;
              const limit = cfg.current.stepMs * 2.5;
              for (let i = i0; i < i1; i++) {
                if (xs[i + 1]! - xs[i]! > limit) {
                  nullGaps.push([Math.round(u.valToPos(xs[i]!, 'x', true)), Math.round(u.valToPos(xs[i + 1]!, 'x', true))]);
                }
              }
              return nullGaps;
            },
          }),
        ),
      ],
      hooks: {
        draw: [
          (u) => {
            const g = cfg.current.ghost;
            if (!g || g.buffer.length < 2) return;
            const t = g.buffer.times();
            const y = g.buffer.column(g.column);
            const xMin = u.scales.x!.min ?? 0;
            const xMax = u.scales.x!.max ?? 0;
            const gapLimit = (t.length > 1 ? Math.min(t[1]! - t[0]!, 60_000) : 1000) * 2.5;
            const { ctx, bbox } = u;
            ctx.save();
            ctx.beginPath();
            ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
            ctx.clip();
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < t.length; i++) {
              const x = t[i]! + g.offsetMs;
              if (x < xMin - 60_000 || x > xMax + 60_000) {
                pen = false;
                continue;
              }
              if (pen && t[i]! - t[i - 1]! > gapLimit) pen = false;
              const px = u.valToPos(x, 'x', true);
              const py = u.valToPos(y[i]!, 'y', true);
              if (pen) ctx.lineTo(px, py);
              else ctx.moveTo(px, py);
              pen = true;
            }
            ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
            ctx.lineWidth = 1.5 * devicePixelRatio;
            ctx.strokeStyle = faint;
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };

    const u = new uPlot(opts, [[], ...series.map(() => [])], wrap);

    const draw = () => {
      const c = cfg.current;
      const data = [c.buffer.times(), ...series.map((s) => c.buffer.column(s.column))];
      u.setData(data as uPlot.AlignedData, false);
      const now = clock.now();
      u.setScale('x', { min: now - c.rangeMs, max: now });
      u.redraw(false, true);
      // With the pointer off the chart (here and on its synced neighbours) the legend reads the newest
      // point, so it is a live readout rather than a row of dashes.
      const n = data[0]!.length;
      if (n && !((u.cursor.left ?? -1) >= 0)) u.setLegend({ idx: n - 1 }, false);
    };

    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry!.contentRect.width);
      if (w > 0 && w !== u.width) u.setSize({ width: w, height: cfg.current.height ?? 190 });
    });
    ro.observe(wrap);

    const drawer = store.addDrawer(cfg.current.drawKey, draw);
    // The window ends at "now", so it must keep moving even when no point arrives: a stalled stream then
    // shows as a growing blank at the right edge instead of a chart that looks frozen but current.
    const key = cfg.current.drawKey;
    const ticker = setInterval(() => store.markDirty(key), 1000);
    return () => {
      clearInterval(ticker);
      drawer.dispose();
      ro.disconnect();
      u.destroy();
    };
    // The chart is rebuilt only when its identity changes; everything else is read through `cfg`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drawKey, seriesSig, props.unit, props.yMax, props.yFloor, props.syncKey, appearance]);

  // The ghost has its own buffer: redraw when it changes, and when it is switched on or off.
  const ghostKey = props.ghost?.drawKey ?? null;
  useEffect(() => {
    store.markDirty(props.drawKey);
    if (!ghostKey) return;
    const drawer = store.addDrawer(ghostKey, () => store.markDirty(props.drawKey));
    return () => drawer.dispose();
  }, [ghostKey, props.drawKey]);

  // A new range or step changes the x window without any new data arriving.
  useEffect(() => {
    store.markDirty(props.drawKey);
  }, [props.rangeMs, props.stepMs, props.buffer, props.drawKey]);

  return <div ref={wrapRef} role="img" aria-label={props.ariaLabel} className="w-full" />;
}
