import { hotkey } from '../lib/shortcuts';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, ShieldCheck, Siren } from 'lucide-react';
import { SERVICE_BY_ID, isServiceId, type IncidentDTO } from '@epicenter/shared';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { clockTime, duration } from '../lib/format';
import { useIncidents } from '../state/incidentStore';

type Filter = 'open' | 'all';
const nameOf = (id: string | null) => (id && isServiceId(id) ? SERVICE_BY_ID[id].name : (id ?? 'Locating…'));

/** Re-renders once a second while any listed incident is open, so running durations tick. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Row({ inc, now }: { inc: IncidentDTO; now: number }) {
  const open = inc.state === 'open';
  return (
    <li>
      <Link
        to={`/incidents/${inc.id}`}
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line px-4 py-3 transition-colors last:border-0 hover:bg-raised sm:grid-cols-[auto_minmax(0,1fr)_auto] [li:first-child>&]:rounded-t-lg [li:last-child>&]:rounded-b-lg"
      >
        {open ? <Siren aria-hidden className="mt-0.5 size-4 text-crit" /> : <CircleCheck aria-hidden className="mt-0.5 size-4 text-faint" />}
        <div className="min-w-0">
          <p className={`truncate text-sm ${open ? 'text-fg' : 'text-muted'}`}>
            <span className="sr-only">{open ? 'Open' : 'Resolved'}: </span>
            {inc.title || 'Incident'}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Epicenter <span className="text-fg">{nameOf(inc.epicenter)}</span> · {Math.round(inc.confidence * 100)}% confidence ·{' '}
            {inc.affected.length} service{inc.affected.length === 1 ? '' : 's'} alerting
          </p>
        </div>
        <div className="col-start-2 text-xs text-muted sm:col-start-3 sm:text-right">
          <p>
            <span className="metric">{clockTime(inc.startedAt)}</span>
          </p>
          <p>{open ? `open ${duration(now - inc.startedAt)}` : `lasted ${duration((inc.endedAt ?? inc.startedAt) - inc.startedAt)}`}</p>
        </div>
      </Link>
    </li>
  );
}

export function Incidents() {
  const incidents = useIncidents((s) => s.incidents);
  const status = useIncidents((s) => s.status);
  const error = useIncidents((s) => s.error);
  const reload = useIncidents((s) => s.load);
  const openCount = incidents.filter((i) => i.state === 'open').length;
  const [filter, setFilter] = useState<Filter>(openCount ? 'open' : 'all');
  const rows = useMemo(() => (filter === 'open' ? incidents.filter((i) => i.state === 'open') : incidents), [incidents, filter]);
  const now = useNow(openCount > 0);

  const tab = (value: Filter, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={filter === value}
      onClick={() => setFilter(value)}
      {...hotkey('a')}
      className="segment px-3 py-1.5 text-sm"
    >
      {label}
    </button>
  );

  let body;
  if (status === 'unavailable') {
    body = (
      <EmptyState
        icon={<ShieldCheck aria-hidden className="size-6" />}
        title="Incidents are not available yet"
        body="This server does not correlate alerts into incidents yet. Live metrics, the topology and history still work."
      />
    );
  } else if (status === 'error') {
    body = (
      <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-sm text-muted">
        <p>{error}</p>
        <button type="button" onClick={() => void reload()} className="text-accent hover:text-accent-strong">
          Try again
        </button>
      </div>
    );
  } else if (status !== 'ready') {
    body = (
      <div className="flex min-h-48 items-center justify-center text-sm text-muted" role="status">
        Loading incidents…
      </div>
    );
  } else if (!rows.length) {
    body = (
      <EmptyState
        icon={<ShieldCheck aria-hidden className="size-6" />}
        title={filter === 'open' ? 'No open incidents' : 'No incidents yet'}
        body="When alerts on related services fire together, they are grouped into one incident with its epicenter."
      />
    );
  } else {
    body = (
      <ul className="card" aria-label="Incidents, newest first">
        {rows.map((inc) => (
          <Row key={inc.id} inc={inc} now={now} />
        ))}
      </ul>
    );
  }

  return (
    <>
      <PageHeader
        title="Incidents"
        subtitle="Correlated alerts, each with its epicenter and a recording you can replay"
        actions={
          <div role="tablist" aria-label="Incident filter" className="segmented flex gap-1 rounded-md border border-line p-0.5">
            {tab('open', `Open ${openCount}`)}
            {tab('all', `All ${incidents.length}`)}
          </div>
        }
      />
      {body}
    </>
  );
}
