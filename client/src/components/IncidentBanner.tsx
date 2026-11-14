import { Siren } from 'lucide-react';
import { Link } from 'react-router-dom';
import { clockTime } from '../lib/format';
import { hotkey } from '../lib/shortcuts';
import { selectOpenIncidents, useIncidents } from '../state/incidentStore';
import { useShallow } from 'zustand/react/shallow';

/** Shown on top of the Overview while any incident is open. */
export function IncidentBanner() {
  const open = useIncidents(useShallow(selectOpenIncidents));
  const inc = open[0];
  if (!inc) return null;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-crit/40 bg-crit/10 px-4 py-3">
      <Siren aria-hidden className="size-5 shrink-0 text-crit" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-sm font-medium">
          <span className="sr-only">Open incident: </span>
          {inc.title || 'Incident open'}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {inc.epicenter ? (
            <>
              Epicenter <span className="metric text-fg">{inc.epicenter}</span> · {Math.round(inc.confidence * 100)}% confidence ·{' '}
            </>
          ) : (
            'Locating the epicenter · '
          )}
          started <span className="metric">{clockTime(inc.startedAt)}</span>
          {open.length > 1 && ` · and ${open.length - 1} more open`}
        </p>
      </div>
      <Link
        to={`/incidents/${inc.id}`}
        {...hotkey('i')}
        className="btn bg-surface px-3 text-fg"
      >
        Open incident
      </Link>
    </div>
  );
}
