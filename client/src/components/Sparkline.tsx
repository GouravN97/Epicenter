/** Small trend line for a stat tile: recessive line, the current value marked in the accent. */
export function Sparkline({ values, width = 96, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const pad = 3;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Keep a flat series flat and a quiet series from being stretched into drama.
  const span = Math.max(max - min, Math.abs(max) * 0.05, 1e-9);
  const mid = (max + min) / 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height / 2 - ((v - mid) / span) * (height - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0 overflow-visible">
      <polyline points={points} fill="none" stroke="var(--color-faint)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last]!)} r="2.5" fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth="1.5" />
    </svg>
  );
}
