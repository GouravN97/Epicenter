// Live alert feed (plan §9.3): windowed list, newest first. Only the rows on screen are in the DOM, so
// an alert storm does not grow the page.
import { DETECTED_METRICS, type DetectedMetric } from '@epicenter/shared';
import { Download } from 'lucide-react';
import { METRIC_LABELS, buildAlertsExport, downloadJson, exportFilename, filterAlertsByMetric } from '../lib/dataExport';
import { hotkey } from '../lib/shortcuts';
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
          className="btn shrink-0 gap-1 px-2 py-1 text-xs text-muted"
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
  const [metric, setMetric] = useState<DetectedMetric | 'all'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeCount = useMemo(() => alerts.reduce((n, a) => n + (a.state === 'resolved' ? 0 : 1), 0), [alerts]);
  const rows = useMemo(() => filterAlertsByMetric(filter === 'active' ? alerts.filter((a) => a.state !== 'resolved') : alerts, metric), [alerts, filter, metric]);

  /** Saves the alerts the feed is showing, with the filters that chose them. */
  function onExport() {
    const now = Date.now();
    downloadJson(exportFilename(`alerts-${filter}-${metric}`, now), buildAlertsExport(rows, { state: filter, metric }, now));
  }

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
      {...hotkey('a')}
      className="segment px-2.5 py-1 text-xs"
    >
      {label}
    </button>
  );

  let body;
  if (status === 'unavailable') {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <BellOff aria-hidden className="size-6 text-faint" />
        <p className="text-sm text-fg">Alerts are not available yet</p>
        <p className="text-sm text-muted">This server does not provide alerts. Live metrics still work.</p>
      </div>
    );
  } else if (status === 'error') {
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
        <p className="text-sm text-fg">{metric !== 'all' ? `No ${filter === 'active' ? 'active ' : ''}${METRIC_LABELS[metric]} alerts` : filter === 'active' ? 'No active alerts' : 'No alerts yet'}</p>
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
    <section className="card flex h-full min-w-0 flex-col">
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="panel-title">Alerts</h2>
        <div role="tablist" aria-label="Alert filter" className="segmented flex gap-1">
          {tab('active', `Active ${activeCount}`)}
          {tab('all', `All ${alerts.length}`)}
        </div>
      </header>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <label htmlFor="alert-metric" className="sr-only">
          Filter alerts by metric
        </label>
        <select id="alert-metric" value={metric} onChange={(e) => setMetric(e.target.value as DetectedMetric | 'all')} className="field min-w-0 flex-1 px-2 py-1 text-xs">
          <option value="all">All metrics</option>
          {DETECTED_METRICS.map((m) => (
            <option key={m} value={m}>
              {METRIC_LABELS[m]}
            </option>
          ))}
        </select>
        <button type="button" onClick={onExport} disabled={rows.length === 0} {...hotkey('e')} className="btn shrink-0 px-2 py-1 text-xs text-muted hover:text-fg" title="Save the alerts shown as a .json file (E)">
          <Download aria-hidden className="size-3.5" />
          Export JSON
        </button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
}
