import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

export interface StatTileProps {
  label: string;
  /** Formatted value; "–" while there is no data. */
  value: string;
  unit?: string;
  /** One short line of context under the value. */
  hint?: ReactNode;
  /** Recent values, oldest first. */
  trend?: number[];
  icon?: ReactNode;
}

/** A headline number. The parent passes new props at most once a second. */
export function StatTile({ label, value, unit, hint, trend, icon }: StatTileProps) {
  return (
    <div className="flex min-w-0 flex-col justify-between rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className="shrink-0 whitespace-nowrap">
          <span className="metric text-2xl font-semibold tracking-tight">{value}</span>
          {unit && <span className="ml-1 text-sm text-muted">{unit}</span>}
        </div>
        {/* Hidden on the narrowest tiles, where it would squeeze the number it supports. */}
        {trend && (
          <div className="hidden min-w-0 justify-end overflow-hidden sm:flex">
            <Sparkline values={trend} />
          </div>
        )}
      </div>
      <div className="mt-1 min-h-4 truncate text-xs text-muted">{hint}</div>
    </div>
  );
}
