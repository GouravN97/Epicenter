// Live alert feed (plan §9.3): windowed list, newest first. Only the rows on screen are in the DOM, so
// an alert storm does not grow the page.
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { BellOff, Check, CircleCheck, OctagonAlert, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AlertDTO } from '@epicenter/shared';
import { clockTime } from '../lib/format';
import { useAlerts } from '../state/alertStore';
import { hasRole, useAuth } from '../state/authStore';

const ROW_H = 88;
type Filter = 'active' | 'all';

function AlertRow({ alert, fresh, canAck }: { alert: AlertDTO; fresh: boolean; canAck: boolean }) {
  const ack = useAlerts((s) => s.ack);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolved = alert.state === 'resolved';
  const Icon = resolved ? CircleCheck : alert.severity === 'crit' ? OctagonAlert : TriangleAlert;
  const tone = resolved ? 'text-faint' : alert.severity === 'crit' ? 'text-crit' : 'text-warn';
  const stateLabel = resolved ? 'Resolved' : alert.state === 'acked' ? `Acknowledged${alert.ackedBy ? ` by ${alert.ackedBy}` : ''}` : 'Firing';

  async function onAck() {
    setBusy(true);
    setFailed(false);
    try {
      await ack(alert.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`flex h-full items-start gap-3 border-b border-line px-4 py-2.5 ${fresh ? 'fresh-row' : ''}`}>
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <p className={`line-clamp-2 text-sm leading-5 [overflow-wrap:anywhere] ${resolved ? 'text-muted' : 'text-fg'}`} title={alert.message}>
          <span className="sr-only">{resolved ? 'Resolved' : alert.severity === 'crit' ? 'Critical' : 'Warning'}: </span>
          {alert.message}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="metric shrink-0">{clockTime(alert.startedAt)}</span>
          <span aria-hidden>·</span>
          <Link to={`/node/${encodeURIComponent(alert.nodeId)}`} title={alert.nodeId} className="metric min-w-0 truncate text-accent hover:text-accent-strong">
            {alert.nodeId}
          </Link>
          <span aria-hidden>·</span>
          <span className="shrink-0">{failed ? 'Could not acknowledge' : stateLabel}</span>
        </p>
      </div>
      {canAck && alert.state === 'firing' && (
        <button
          type="button"
          onClick={onAck}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-accent hover:text-accent-strong disabled:opacity-50"
        >
          <Check aria-hidden className="size-3.5" />
          Ack
        </button>
      )}
    </div>
  );
}

export function AlertFeed() {
  const alerts = useAlerts((s) => s.alerts);
  const status = useAlerts((s) => s.status);
  const error = useAlerts((s) => s.error);
  const fresh = useAlerts((s) => s.fresh);
  const reload = useAlerts((s) => s.load);
  const canAck = hasRole(
    useAuth((s) => s.user),
    'admin',
    'sre',
  );
  const [filter, setFilter] = useState<Filter>('active');
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeCount = useMemo(() => alerts.reduce((n, a) => n + (a.state === 'resolved' ? 0 : 1), 0), [alerts]);
  const rows = useMemo(() => (filter === 'active' ? alerts.filter((a) => a.state !== 'resolved') : alerts), [alerts, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    getItemKey: (i) => rows[i]!.id,
    overscan: 6,
  });

  const tab = (value: Filter, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={filter === value}
      onClick={() => setFilter(value)}
      className={`rounded px-2.5 py-1 text-xs transition-colors ${filter === value ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:text-fg'}`}
    >
      {label}
    </button>
  );

  let body;
  if (status === 'error') {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
        <p>{error ?? 'Could not load alerts'}</p>
        <button type="button" onClick={() => void reload()} className="text-accent hover:text-accent-strong">
          Try again
        </button>
      </div>
    );
  } else if (status !== 'ready') {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-muted" role="status">
        Loading alerts…
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <BellOff aria-hidden className="size-6 text-faint" />
        <p className="text-sm text-fg">{filter === 'active' ? 'No active alerts' : 'No alerts yet'}</p>
        <p className="text-sm text-muted">{filter === 'active' ? 'Everything you can see is within its normal range.' : 'Alerts appear here as soon as one fires.'}</p>
      </div>
    );
  } else {
    body = (
      <div ref={scrollRef} className="h-full overflow-y-auto" tabIndex={0} aria-label="Alerts, newest first">
        <div role="list" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const alert = rows[item.index]!;
            return (
              <div
                key={item.key}
                role="listitem"
                className="absolute inset-x-0 top-0"
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <AlertRow alert={alert} fresh={fresh.has(alert.id)} canAck={canAck} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full min-w-0 flex-col rounded-lg border border-line bg-surface">
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="text-sm font-medium">Alerts</h2>
        <div role="tablist" aria-label="Alert filter" className="flex gap-1">
          {tab('active', `Active ${activeCount}`)}
          {tab('all', `All ${alerts.length}`)}
        </div>
      </header>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
