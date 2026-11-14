/** 1284 → "1,284", 12940 → "12.9K", 4200000 → "4.2M". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** Latency: "38 ms", "1.24 s". */
export function ms(n: number): { value: string; unit: string } {
  if (!Number.isFinite(n)) return { value: '–', unit: 'ms' };
  return n >= 1000 ? { value: (n / 1000).toFixed(2), unit: 's' } : { value: String(Math.round(n)), unit: 'ms' };
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** "14:03:27" in the viewer's time zone. */
export const clockTime = (epochMs: number): string => timeFmt.format(epochMs);

/** "42 s", "3 m 05 s", "1 h 12 m". */
export function duration(msTotal: number): string {
  const s = Math.max(0, Math.round(msTotal / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
}
