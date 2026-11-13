import { useConnection, type ConnectionStatus } from '../lib/socket';

// Status is carried by the label as well as the dot colour, never by colour alone (plan §9.3).
const VIEW: Record<ConnectionStatus, { label: string; dot: string; pulse?: boolean }> = {
  live: { label: 'Live', dot: 'bg-ok' },
  connecting: { label: 'Connecting', dot: 'bg-warn', pulse: true },
  reconnecting: { label: 'Reconnecting', dot: 'bg-warn', pulse: true },
  offline: { label: 'Offline', dot: 'bg-crit' },
  mock: { label: 'Mock data', dot: 'bg-silent' },
};

export function ConnectionBadge() {
  const status = useConnection((s) => s.status);
  const v = VIEW[status];
  return (
    <span
      role="status"
      aria-label={`Connection: ${v.label}`}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted"
    >
      <span className={`size-2 rounded-full ${v.dot} ${v.pulse ? 'animate-pulse' : ''}`} />
      {v.label}
    </span>
  );
}
