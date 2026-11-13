// Chaos Lab (plan §9.1, B8): start any scenario against a chosen target, watch active runs count down,
// stop one or all, and see how fast and how accurately each run was detected.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CircleCheck,
  CircleX,
  Copy,
  Cpu,
  Database,
  FileWarning,
  FlaskConical,
  MemoryStick,
  Network,
  PowerOff,
  Square,
  TrendingUp,
  ZapOff,
  type LucideIcon,
} from 'lucide-react';
import { SERVICES, SERVICE_BY_ID, isServiceId, room, type ChaosActiveRun, type ChaosScenarioDef, type ChaosScenarioId } from '@epicenter/shared';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { useTopology } from '../data/hooks';
import { clock } from '../data/live';
import { useRoom } from '../data/useRoom';
import { useSocketEvent } from '../data/useSocketEvent';
import { clockTime, duration } from '../lib/format';
import { USE_MOCK } from '../lib/env';
import { useChaos, type RunRow } from '../state/chaosStore';

const ICONS: Record<ChaosScenarioId, LucideIcon> = {
  'cpu-spike': Cpu,
  'memory-leak': MemoryStick,
  'node-kill': PowerOff,
  'slow-db': Database,
  'cache-outage': ZapOff,
  'traffic-surge': TrendingUp,
  'duplicate-storm': Copy,
  'malformed-flood': FileWarning,
};

/** Where to watch each scenario happen. */
function watchLink(def: ChaosScenarioDef, target: string | null): { to: string; label: string } {
  if (def.id === 'traffic-surge' || def.id === 'duplicate-storm' || def.id === 'malformed-flood') return { to: '/pipeline', label: 'Watch the pipeline' };
  if (def.targetKind === 'node' && target) return { to: `/node/${encodeURIComponent(target)}`, label: 'Watch the node' };
  return { to: '/topology', label: 'Watch the topology' };
}

/** Sensible starting targets, so one click gives a clear demo. */
const DEFAULT_NODE_SERVICE: Partial<Record<ChaosScenarioId, string>> = {
  'cpu-spike': 'payments',
  'memory-leak': 'catalog-api',
  'node-kill': 'worker',
};
const DURATIONS = [30, 60, 90, 120, 240, 300, 600];
const scenarioName = (scenarios: readonly ChaosScenarioDef[], id: string) => scenarios.find((s) => s.id === id)?.name ?? id;
const targetLabel = (target: string | null) => (target ? (isServiceId(target) ? SERVICE_BY_ID[target].name : target) : 'Whole fleet');

/** Re-renders once a second while `active`, for countdowns. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => clock.liveNow());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(clock.liveNow()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ActiveRuns({ runs, scenarios, now }: { runs: ChaosActiveRun[]; scenarios: readonly ChaosScenarioDef[]; now: number }) {
  const stop = useChaos((s) => s.stop);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onStop(runId?: string) {
    setBusy(runId ?? 'all');
    setError(null);
    try {
      await stop(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the run');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title={`Running now${runs.length ? ` · ${runs.length}` : ''}`}
      actions={
        runs.length > 1 ? (
          <button
            type="button"
            onClick={() => void onStop()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-crit/50 px-2.5 py-1 text-xs text-crit transition-colors hover:bg-crit/10 disabled:opacity-50"
          >
            <Square aria-hidden className="size-3" />
            Stop all
          </button>
        ) : undefined
      }
    >
      {runs.length ? (
        <ul className="divide-y divide-line">
          {runs.map((r) => {
            const def = scenarios.find((s) => s.id === r.scenario);
            const Icon = ICONS[r.scenario] ?? FlaskConical;
            const left = Math.max(0, r.endsAt - now);
            const link = def ? watchLink(def, r.target) : null;
            return (
              <li key={r.runId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-crit/15 text-crit">
                  <Icon aria-hidden className="size-4" />
                  <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-crit/20 [animation-duration:2s]" />
                </span>
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm font-medium">{def?.name ?? r.scenario}</p>
                  <p className="metric truncate text-xs text-muted">{targetLabel(r.target)}</p>
                </div>
                <p className="text-sm text-muted">
                  ends in <span className="metric text-fg">{duration(left)}</span>
                </p>
                {link && (
                  <Link to={link.to} className="text-sm text-accent hover:text-accent-strong">
                    {link.label}
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => void onStop(r.runId)}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-sm text-fg transition-colors hover:border-crit hover:text-crit disabled:opacity-50"
                >
                  <Square aria-hidden className="size-3.5" />
                  {busy === r.runId ? 'Stopping…' : 'Stop'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted">No faults running. Start one below and watch Epicenter find it.</p>
      )}
      {error && (
        <p role="alert" className="border-t border-line px-4 py-2 text-sm text-crit">
          {error}
        </p>
      )}
    </Panel>
  );
}

function TargetPicker({ def, value, onChange }: { def: ChaosScenarioDef; value: string; onChange: (v: string) => void }) {
  const topo = useTopology();
  const select =
    'w-full min-w-0 rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-60';
  if (def.targetKind === 'none') {
    return <p className="rounded-md border border-dashed border-line px-2.5 py-1.5 text-sm text-muted">Whole fleet</p>;
  }
  if (def.targetKind === 'service') {
    return (
      <select aria-label="Target service" value={value} onChange={(e) => onChange(e.target.value)} className={select}>
        {SERVICES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <select aria-label="Target node" value={value} onChange={(e) => onChange(e.target.value)} className={`${select} metric`} disabled={!topo}>
      {!topo && <option>Loading nodes…</option>}
      {SERVICES.map((s) => {
        const nodes = (topo?.nodes ?? []).filter((n) => n[2] === s.id);
        if (!nodes.length) return null;
        return (
          <optgroup key={s.id} label={s.name}>
            {nodes.map((n) => (
              <option key={n[1]} value={n[1]}>
                {n[1]}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

function ScenarioCard({ def, running }: { def: ChaosScenarioDef; running: ChaosActiveRun[] }) {
  const start = useChaos((s) => s.start);
  const topo = useTopology();
  const defaultTarget = useMemo(() => {
    if (def.targetKind === 'service') return def.defaultTarget ?? 'db';
    if (def.targetKind === 'node') {
      const svc = DEFAULT_NODE_SERVICE[def.id] ?? 'worker';
      return topo?.nodes.find((n) => n[2] === svc)?.[1] ?? topo?.nodes[0]?.[1] ?? '';
    }
    return '';
  }, [def, topo]);
  const [target, setTarget] = useState('');
  const [secs, setSecs] = useState(def.defaultDurationSec);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = target || defaultTarget;
  const Icon = ICONS[def.id] ?? FlaskConical;
  const live = running.find((r) => r.scenario === def.id && (def.targetKind === 'none' || r.target === chosen));
  const durations = DURATIONS.includes(def.defaultDurationSec) ? DURATIONS : [...DURATIONS, def.defaultDurationSec].sort((a, b) => a - b);

  async function onStart() {
    setBusy(true);
    setError(null);
    try {
      await start({ scenario: def.id, ...(def.targetKind === 'none' ? {} : { target: chosen }), durationSec: secs });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the scenario');
    } finally {
      setBusy(false);
    }
  }

  const id = `scn-${def.id}`;
  return (
    <article aria-labelledby={id} className={`flex flex-col rounded-lg border bg-surface p-4 ${live ? 'border-crit/50' : 'border-line'}`}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-raised text-accent">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold">
            {def.name}
          </h3>
          <p className="text-sm text-muted">{def.description}</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        <span className="text-faint">Expect: </span>
        {def.expected}
      </p>
      <div className="mt-auto space-y-2 pt-4">
        <TargetPicker def={def} value={chosen} onChange={setTarget} />
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
          <select
            aria-label="Duration"
            value={secs}
            onChange={(e) => setSecs(Number(e.target.value))}
            className="metric rounded-md border border-line bg-bg px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {durations.map((d) => (
              <option key={d} value={d}>
                {duration(d * 1000)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={busy || (def.targetKind === 'node' && !chosen)}
            className="w-full rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            {busy ? 'Starting…' : live ? 'Start another' : 'Start'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-crit">
          {error}
        </p>
      )}
    </article>
  );
}

/** How long after a run ends a detection can still arrive (alerts need a few seconds of evidence). */
const DETECTION_GRACE_MS = 15_000;

function Verdict({ row, now }: { row: RunRow; now: number }) {
  if (row.detectedAt === null) {
    const over = row.endedAt != null && now - row.endedAt > DETECTION_GRACE_MS;
    return over ? (
      <span className="inline-flex items-center gap-1.5 text-warn">
        <CircleX aria-hidden className="size-4" />
        Not detected
      </span>
    ) : (
      <span className="text-muted">Not detected yet</span>
    );
  }
  if (row.correct === null) return <span className="text-muted">Detected · not scored</span>;
  return row.correct ? (
    <span className="inline-flex items-center gap-1.5 text-ok">
      <CircleCheck aria-hidden className="size-4" />
      Correct
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-crit">
      <CircleX aria-hidden className="size-4" />
      Wrong root cause
    </span>
  );
}

function History({ rows, scenarios, serverHistory, now }: { rows: RunRow[]; scenarios: readonly ChaosScenarioDef[]; serverHistory: boolean; now: number }) {
  if (!rows.length) {
    return <p className="px-4 py-6 text-center text-sm text-muted">Finished runs and how quickly each was caught appear here.</p>;
  }
  const cell = 'px-3 py-2';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className={`${cell} pl-4 font-normal`}>Scenario</th>
            <th className={`${cell} font-normal`}>Target</th>
            <th className={`${cell} font-normal`}>Started</th>
            <th className={`${cell} text-right font-normal`}>Time to detect</th>
            <th className={`${cell} font-normal`}>Detected epicenter</th>
            <th className={`${cell} font-normal`}>Verdict</th>
            <th className={`${cell} pr-4 font-normal`}>
              <span className="sr-only">Incident</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.runId} className="border-b border-line last:border-0">
              <td className={`${cell} pl-4`}>{scenarioName(scenarios, r.scenario)}</td>
              <td className={`${cell} metric max-w-56 truncate text-muted`}>{targetLabel(r.target)}</td>
              <td className={`${cell} metric text-muted`}>{clockTime(r.startedAt)}</td>
              <td className={`${cell} metric text-right`}>{r.timeToDetectMs !== null ? duration(r.timeToDetectMs) : '–'}</td>
              <td className={cell}>{r.detectedEpicenter ? targetLabel(r.detectedEpicenter) : '–'}</td>
              <td className={cell}>
                <Verdict row={r} now={now} />
              </td>
              <td className={`${cell} pr-4 text-right`}>
                {r.incidentId && (
                  <Link to={`/incidents/${r.incidentId}`} className="text-accent hover:text-accent-strong">
                    Incident
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!serverHistory && <p className="px-4 py-2 text-xs text-muted">Showing runs started from this tab; the server keeps no run history yet.</p>}
    </div>
  );
}

export function ChaosLab() {
  const { scenarios, active, history, serverHistory, status, error, load, loadHistory, applyUpdate } = useChaos();
  useRoom(room.meta); // chaos:upd is broadcast on the meta room
  useSocketEvent('chaos:upd', applyUpdate);
  // A new incident may be the detection of a run: refresh the scorecards.
  useSocketEvent('incident:new', () => void loadHistory());
  useSocketEvent('incident:upd', () => void loadHistory());

  useEffect(() => {
    void load();
    void loadHistory();
    const t = setInterval(() => void loadHistory(), 5000);
    return () => clearInterval(t);
  }, [load, loadHistory]);
  const now = useTicker(active.length > 0 || history.some((r) => r.detectedAt === null));

  const groups: { title: string; hint: string; icon: ReactNode; ids: ChaosScenarioId[] }[] = [
    { title: 'Service faults', hint: 'Break a dependency and watch the failure spread up the graph.', icon: <Network aria-hidden className="size-4" />, ids: ['slow-db', 'cache-outage'] },
    { title: 'Node faults', hint: 'One machine misbehaves.', icon: <Cpu aria-hidden className="size-4" />, ids: ['cpu-spike', 'memory-leak', 'node-kill'] },
    {
      title: 'Pipeline stress',
      hint: 'Attack the ingest path: validation, dedup and rate limiting at work.',
      icon: <Activity aria-hidden className="size-4" />,
      ids: ['traffic-surge', 'duplicate-storm', 'malformed-flood'],
    },
  ];

  return (
    <>
      <PageHeader title="Chaos Lab" subtitle="Inject a fault, then see how fast Epicenter detects it and whether it names the right root cause" />
      {status === 'error' && (
        <p role="alert" className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm">
          {error}. The scenarios below come from the shared contract; starting one will report any problem.
        </p>
      )}
      {USE_MOCK && (
        <p className="mb-4 text-xs text-muted">Mock mode: a background fault also runs every four minutes. It pauses while any of your runs is active.</p>
      )}

      <ActiveRuns runs={active} scenarios={scenarios} now={now} />

      {groups.map((g) => {
        const defs = g.ids.map((id) => scenarios.find((s) => s.id === id)).filter((d): d is ChaosScenarioDef => !!d);
        if (!defs.length) return null;
        return (
          <section key={g.title} className="mt-6" aria-label={g.title}>
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <span className="text-muted">{g.icon}</span>
              {g.title}
            </h2>
            <p className="mb-3 text-xs text-muted">{g.hint}</p>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {defs.map((d) => (
                <ScenarioCard key={d.id} def={d} running={active} />
              ))}
            </div>
          </section>
        );
      })}

      <Panel title="Scorecards" className="mt-6">
        <History rows={history} scenarios={scenarios} serverHistory={serverHistory} now={now} />
      </Panel>
    </>
  );
}
