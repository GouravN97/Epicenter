// Automated analysis of one incident: why this epicenter, what to check next, similar past incidents, and a
// postmortem draft to copy or download. The server computes it with fixed rules (shared/insights.ts); there
// is no AI model behind it, and the panel says so.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Copy, Download } from 'lucide-react';
import { SERVICE_BY_ID, isServiceId, type IncidentInsightsDTO, type InsightRole } from '@epicenter/shared';
import { api, HttpError } from '../lib/api';
import { downloadText, exportFilename } from '../lib/dataExport';
import { duration } from '../lib/format';
import { Panel } from './Panel';

const nameOf = (id: string) => (isServiceId(id) ? SERVICE_BY_ID[id].name : id);
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ROLE: Record<InsightRole, { label: string; tone: string }> = {
  epicenter: { label: 'Epicenter', tone: 'bg-crit/15 text-crit' },
  downstream: { label: 'Calls it', tone: 'bg-fill text-muted' },
  unexplained: { label: 'Unexplained', tone: 'bg-warn/15 text-warn' },
};

type Load = { status: 'loading' } | { status: 'ready'; data: IncidentInsightsDTO } | { status: 'unavailable' } | { status: 'error'; message: string };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * `refreshKey` changes when the incident does (state, epicenter, affected services, alert count); the
 * analysis is then fetched again, a moment later so a burst of alerts costs one request.
 */
export function IncidentInsights({ incidentId, refreshKey }: { incidentId: string; refreshKey: string }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
    setLoad({ status: 'loading' });
  }, [incidentId]);

  useEffect(() => {
    const ctl = new AbortController();
    const run = async () => {
      try {
        const data = await api.get<IncidentInsightsDTO>(`/incidents/${encodeURIComponent(incidentId)}/insights`, undefined, ctl.signal);
        setLoad({ status: 'ready', data });
      } catch (err) {
        if (ctl.signal.aborted) return;
        // An older server has no such route: say so once, quietly, and keep what was shown if anything was.
        if (err instanceof HttpError && err.status === 404) setLoad({ status: 'unavailable' });
        else setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: err instanceof Error ? err.message : 'Could not load the analysis' }));
      }
    };
    const t = setTimeout(() => void run(), first.current ? 0 : 1500);
    first.current = false;
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [incidentId, refreshKey]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const data = load.status === 'ready' ? load.data : null;
  const save = () => data && downloadText(exportFilename(`incident-${incidentId}`, data.generatedAt, 'md'), data.postmortem);
  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.postmortem);
      setCopied(true);
    } catch {
      save(); // no clipboard access (plain http, or permission refused): hand over the file instead
    }
  };

  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-muted">Rule-based, no AI model</span>
      <button type="button" className="btn" onClick={() => void copy()} disabled={!data}>
        {copied ? <Check aria-hidden className="size-3.5 text-ok" /> : <Copy aria-hidden className="size-3.5" />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy report'}</span>
      </button>
      <button type="button" className="btn" onClick={save} disabled={!data} aria-label="Download report as Markdown">
        <Download aria-hidden className="size-3.5" />
        .md
      </button>
    </div>
  );

  return (
    <Panel title="Automated analysis" tour="incident-insights" actions={actions} className="mt-4">
      {!data ? (
        <p className="px-4 py-10 text-center text-sm text-muted" role="status">
          {load.status === 'loading' ? 'Analysing the incident…' : load.status === 'unavailable' ? 'Analysis is not available on this server yet.' : load.status === 'error' ? load.message : ''}
        </p>
      ) : (
        <div className="grid gap-x-8 gap-y-6 p-4 lg:grid-cols-3">
          <Section title="Why this epicenter">
            <ul className="space-y-1.5 text-sm text-fg">
              {data.evidence.reasons.map((r) => (
                <li key={r} className="flex gap-2">
                  <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
            {data.evidence.services.length > 0 && (
              <ol className="mt-3 space-y-1 border-t border-line pt-3 text-sm" aria-label="Alerting services in order of first alert">
                {data.evidence.services.map((s) => {
                  const t0 = data.evidence.services[0]!.firstAlertAt;
                  return (
                    <li key={s.serviceId} className="flex items-center gap-2">
                      <span className="metric w-12 shrink-0 text-xs text-muted">{s.firstAlertAt === t0 ? 'first' : `+${duration(s.firstAlertAt - t0)}`}</span>
                      <span className="min-w-0 flex-1 truncate text-fg">{nameOf(s.serviceId)}</span>
                      <span className="metric hidden text-xs text-faint sm:inline">{s.dominant}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-mini ${ROLE[s.role].tone}`}>{ROLE[s.role].label}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <Section title="Suggested checks">
            {data.checks.length ? (
              <ol className="space-y-3 text-sm">
                {data.checks.map((c, i) => (
                  <li key={c.id} className="flex gap-2.5">
                    <span className="metric mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-fill text-mini text-muted">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="font-medium text-fg [overflow-wrap:anywhere]">{c.title}</p>
                      <p className="text-muted">{c.detail}</p>
                      {c.target && (
                        <Link
                          to={c.target.kind === 'node' ? `/node/${encodeURIComponent(c.target.id)}` : '/topology'}
                          className="mt-0.5 inline-flex items-center gap-1 text-accent hover:text-accent-strong"
                        >
                          {c.target.kind === 'node' ? `Open ${c.target.id}` : 'Open the topology'}
                          <ArrowRight aria-hidden className="size-3.5" />
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">Nothing to suggest until the epicenter is identified.</p>
            )}
          </Section>

          <Section title="Similar past incidents">
            {data.similar.length ? (
              <ul className="space-y-3 text-sm">
                {data.similar.map((s) => (
                  <li key={s.incident.id}>
                    <Link to={`/incidents/${s.incident.id}`} className="font-medium text-accent hover:text-accent-strong [overflow-wrap:anywhere]">
                      {s.incident.title || 'Incident'}
                    </Link>
                    <p className="text-xs text-muted">
                      <span className="metric">{Math.round(s.score * 100)}%</span> match · {dateFmt.format(s.incident.startedAt)}
                      {s.durationMs !== null && <> · lasted {duration(s.durationMs)}</>}
                    </p>
                    <p className="text-muted">{s.reasons.join(' · ')}</p>
                    {s.notes.map((n) => (
                      <p key={n.text} className="mt-1 border-l-2 border-line pl-2 text-fg">
                        “{n.text}”{n.userName && <span className="text-muted"> — {n.userName}</span>}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No resolved incident resembles this one yet. Matches appear here with how long they lasted and what responders noted.</p>
            )}
          </Section>
        </div>
      )}
    </Panel>
  );
}
