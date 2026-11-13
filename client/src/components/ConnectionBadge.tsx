import { useEffect, useState } from 'react';
import { useClock } from '../data/hooks';
import { delay } from '../data/live';
import { useConnection, type ConnectionStatus } from '../lib/socket';

// Status is carried by the label as well as the dot colour, never by colour alone (plan §9.3).
const VIEW: Record<ConnectionStatus | 'replay', { label: string; dot: string; pulse?: boolean }> = {
  live: { label: 'Live', dot: 'bg-ok' },
  connecting: { label: 'Connecting', dot: 'bg-warn', pulse: true },
  reconnecting: { label: 'Reconnecting', dot: 'bg-warn', pulse: true },
  offline: { label: 'Offline', dot: 'bg-crit' },
  mock: { label: 'Mock data', dot: 'bg-silent' },
  replay: { label: 'Replay', dot: 'bg-accent' },
};

/** Median data delay over the last minute, refreshed once a second. */
function useDelaySeconds(active: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setText(null);
      return;
    }
    const read = () => {
      const p50 = delay.quantile(0.5);
      setText(Number.isFinite(p50) ? `${(Math.max(0, p50) / 1000).toFixed(1)} s` : null);
    };
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [active]);
  return text;
}

export function ConnectionBadge() {
  const status = useConnection((s) => s.status);
  const { mode } = useClock();
  const streaming = status === 'live' || status === 'mock';
  const v = VIEW[mode === 'replay' && streaming ? 'replay' : status];
  const lag = useDelaySeconds(streaming && mode === 'live');
  return (
    <span
      role="status"
      aria-label={`Connection: ${v.label}${lag ? `, data delay ${lag}` : ''}`}
      title={lag ? 'Median delay from a reading being taken to it reaching this screen. About 3 s of it is the window the server holds open for late events.' : undefined}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted"
    >
      <span className={`size-2 rounded-full ${v.dot} ${v.pulse ? 'animate-pulse' : ''}`} />
      {v.label}
      {lag && <span className="metric border-l border-line pl-2 text-fg">{lag}</span>}
    </span>
  );
}
