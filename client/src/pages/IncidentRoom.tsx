// Incident room (plan §9.1): header, time scrubber, topology and heatmap driven by the scrubber, the
// epicenter metric over the recorded window, timeline with notes, presence, and the chaos scorecard.
//
// Live and replay use separate data: the live store keeps filling while you replay, and the recording
// lives in its own FleetState and snapshot. "Go Live" only switches the clock back, so there is nothing
// to catch up and nothing to deduplicate.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CircleCheck, CircleX, FlaskConical, MessageSquare, SearchX, Siren, Users } from 'lucide-react';
import {
  CHAOS_SCENARIOS,
  REPLAY_MAX_RANGE_MS,
  SERVICE_BY_ID,
  isServiceId,
  room,
  type ChaosScorecard,
  type IncidentDetailDTO,
  type IncidentDTO,
  type PresenceUser,
  type TimelineEntry,
  type TopologyResponse,
  type ReplayResponse,
} from '@epicenter/shared';
import { EmptyState } from '../components/EmptyState';
import { FleetHeatmap } from '../components/FleetHeatmap';
import { LiveChart } from '../components/LiveChart';
import { Panel } from '../components/Panel';
import { ReplayChart } from '../components/ReplayChart';
import { TimeScrubber, type ScrubberHandle } from '../components/TimeScrubber';
import { TopologyMap } from '../components/TopologyMap';
import { FleetState } from '../data/fleetState';
import { useClock, useTopology } from '../data/hooks';
import { clock, rooms, store, topology as registry, visibleTeams } from '../data/live';
import { ReplayRecording, incidentMetric, replayWindow, type ReplayMetric } from '../data/replayRecording';
import { useRoom, useRooms } from '../data/useRoom';
import { useSeries } from '../data/useSeries';
import { useSocketEvent } from '../data/useSocketEvent';
import { useTopoSnapshot, type TopoSnapshot } from '../data/useTopoSnapshot';
import { api, HttpError } from '../lib/api';
import { clockTime, duration } from '../lib/format';
import { usePageTitle } from '../lib/usePageTitle';
import { getSocket } from '../lib/socket';
import { incidentView } from '../lib/topologyView';
import { hasRole, useAuth } from '../state/authStore';
import { useIncidents } from '../state/incidentStore';

const REPLAY_FLEET_KEY = 'replay:fleet';
const REPLAY_CHART_KEY = 'replay:chart';
const nameOf = (id: string | null) => (id && isServiceId(id) ? SERVICE_BY_ID[id].name : (id ?? '–'));
const METRIC_VIEW: Record<ReplayMetric, { title: string; unit: string; col: number }> = {
  cpu: { title: 'CPU avg', unit: '%', col: 0 },
  mem: { title: 'Memory avg', unit: '%', col: 1 },
  lat: { title: 'Latency p95', unit: 'ms', col: 5 },
  err: { title: 'Error rate avg', unit: '%', col: 6 },
  rps: { title: 'Traffic', unit: 'req/s', col: 7 },
};
const entryKey = (e: TimelineEntry) => `${e.ts}|${e.kind}|${e.text}`;

// ---------------------------------------------------------------------------------------------- pieces

function Presence({ users }: { users: PresenceUser[] }) {
  if (!users.length) return null;
  return (
    <div className="flex items-center gap-2" aria-label={`In this room: ${users.map((u) => u.name).join(', ')}`}>
      <Users aria-hidden className="size-4 text-muted" />
      <div className="flex -space-x-1.5">
        {users.slice(0, 5).map((u) => (
          <span
            key={u.id}
            title={u.name}
            className="flex size-7 items-center justify-center rounded-full border-2 border-bg bg-raised text-mini font-medium text-fg"
          >
            {u.name
              .split(/\s+/)
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
        ))}
      </div>
      <span className="text-xs text-muted">{users.length === 1 ? '1 here' : `${users.length} here`}</span>
    </div>
  );
}

function Scorecard({ card }: { card: ChaosScorecard }) {
  const scenario = CHAOS_SCENARIOS.find((s) => s.id === card.scenario);
  const verdict =
    card.correct === null ? (
      <span className="text-muted">Not scored yet</span>
    ) : card.correct ? (
      <span className="inline-flex items-center gap-1.5 text-ok">
        <CircleCheck aria-hidden className="size-4" />
        Correct root cause
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-crit">
        <CircleX aria-hidden className="size-4" />
        Wrong root cause
      </span>
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-4 text-sm text-muted">
      <dt>Scenario</dt>
      <dd className="text-fg">{scenario?.name ?? card.scenario}</dd>
      <dt>Injected into</dt>
      <dd className="metric text-fg [overflow-wrap:anywhere]">{card.target ?? '–'}</dd>
      <dt>Injected at</dt>
      <dd className="metric text-fg">{clockTime(card.startedAt)}</dd>
      <dt>Time to detect</dt>
      <dd className="metric text-lg font-semibold text-fg">{card.timeToDetectMs !== null ? duration(card.timeToDetectMs) : '–'}</dd>
      <dt>Detected epicenter</dt>
      <dd className="text-fg">{nameOf(card.detectedEpicenter)}</dd>
      <dt>Verdict</dt>
      <dd>{verdict}</dd>
    </dl>
  );
}

function Timeline({
  entries,
  replayT,
  onSeek,
  canNote,
  incidentId,
}: {
  entries: TimelineEntry[];
  replayT: number | null;
  onSeek: (t: number) => void;
  canNote: boolean;
  incidentId: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/incidents/${encodeURIComponent(incidentId)}/notes`, { text: text.trim() });
      setText(''); // the note itself arrives through incident:note, like everyone else's
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the note');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ol className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Incident timeline, oldest first">
        {entries.map((e) => {
          const future = replayT !== null && e.ts > replayT;
          const tone = e.kind === 'epicenter' ? 'text-crit' : e.kind === 'resolve' ? 'text-ok' : e.kind === 'note' ? 'text-accent' : 'text-faint';
          return (
            <li key={entryKey(e)}>
              <button
                type="button"
                onClick={() => onSeek(e.ts)}
                title="Replay from here"
                className={`flex w-full items-start gap-3 px-4 py-1.5 text-left transition-opacity hover:bg-raised ${future ? 'opacity-40' : ''}`}
              >
                <span className="metric mt-px shrink-0 text-xs text-muted">{clockTime(e.ts)}</span>
                <span className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-current ${tone}`} aria-hidden />
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  {e.kind === 'note' && (
                    <span className="mr-1 inline-flex items-center gap-1 text-accent">
                      <MessageSquare aria-hidden className="size-3.5" />
                      {e.user?.name ?? 'Note'}:
                    </span>
                  )}
                  <span className={e.kind === 'note' || e.kind === 'epicenter' ? 'text-fg' : 'text-muted'}>{e.text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {canNote && (
        <form onSubmit={submit} className="border-t border-line p-3">
          <label htmlFor="note" className="sr-only">
            Add a note to the timeline
          </label>
          <div className="flex gap-2">
            <input
              id="note"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              placeholder="Add a note for the team…"
              className="field min-w-0 flex-1 px-3 py-1.5"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="btn-primary disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1.5 text-xs text-crit">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- page

type RecState = { status: 'idle' | 'loading' | 'ready' } | { status: 'error'; message: string };

export function IncidentRoom() {
  const { id = '' } = useParams();
  const user = useAuth((s) => s.user);
  const topoData = useTopology();
  const fromStore = useIncidents((s) => s.incidents.find((i) => i.id === id));
  const [detail, setDetail] = useState<IncidentDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<{ status: number; message: string } | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [users, setUsers] = useState<PresenceUser[]>([]);

  // The store has the freshest header fields (it follows incident:upd); the detail has alerts and timeline.
  const incident: IncidentDTO | null = fromStore ?? detail;
  const open = incident?.state === 'open';
  usePageTitle(incident ? `${open ? 'Open' : 'Resolved'} incident: ${incident.epicenter ?? 'locating'}` : 'Incident');

  // ---- detail, refetched (debounced) when the incident changes so new alerts reach the timeline
  const loadDetail = useCallback(async () => {
    try {
      const d = await api.get<IncidentDetailDTO>(`/incidents/${encodeURIComponent(id)}`);
      setDetail(d);
      setLoadError(null);
      setTimeline((prev) => {
        const byKey = new Map(prev.map((e) => [entryKey(e), e]));
        for (const e of d.timeline) byKey.set(entryKey(e), e);
        return [...byKey.values()].sort((a, b) => a.ts - b.ts);
      });
    } catch (err) {
      setLoadError({ status: err instanceof HttpError ? err.status : 0, message: err instanceof Error ? err.message : 'Could not load the incident' });
    }
  }, [id]);
  useEffect(() => {
    setDetail(null);
    setTimeline([]);
    setLoadError(null);
    void loadDetail();
  }, [loadDetail]);
  const sig = fromStore ? `${fromStore.state}|${fromStore.epicenter}|${fromStore.affected.join()}|${fromStore.endedAt}` : '';
  useEffect(() => {
    if (!sig) return;
    const t = setTimeout(() => void loadDetail(), 1500);
    return () => clearTimeout(t);
  }, [sig, loadDetail]);

  // ---- war room: notes and presence over incident:<id>
  const { state: roomState } = useRoom(incident ? room.incident(id) : null);
  useSocketEvent('incident:note', (e) =>
    setTimeline((prev) => (prev.some((x) => entryKey(x) === entryKey(e)) ? prev : [...prev, e].sort((a, b) => a.ts - b.ts))),
  );
  useSocketEvent('presence', (p) => setUsers(p.users));
  useEffect(() => {
    if (roomState !== 'joined') return;
    const hello = () => getSocket()?.emit('presence:hello', { incidentId: id }, (ack) => setUsers(ack.users));
    hello();
    return rooms.onConnection((ev) => ev === 'reconnect' && hello());
  }, [roomState, id]);

  // ---- services in play: epicenter, blast radius and everything alerting
  const involved = useMemo(() => {
    if (!incident) return [] as string[];
    return [...new Set([...(incident.epicenter ? [incident.epicenter] : []), ...incident.blastRadius, ...incident.affected])];
  }, [incident]);
  const subTopology = useMemo<TopologyResponse | null>(
    () => (topoData ? { ...topoData, nodes: topoData.nodes.filter((n) => involved.includes(n[2])) } : null),
    [topoData, involved],
  );
  const teams = useMemo(() => visibleTeams(user), [user]);
  useRooms(useMemo(() => [room.topology, ...teams.map((t) => room.fleet(t))], [teams]));
  const liveSnap = useTopoSnapshot();

  // ---- recording
  const [rec, setRec] = useState<ReplayRecording | null>(null);
  const [recState, setRecState] = useState<RecState>({ status: 'idle' });
  const replayFleet = useMemo(() => new FleetState(), []);
  const scrubber = useRef<ScrubberHandle>(null);
  const { mode, playing } = useClock();
  const replaying = mode === 'replay';
  const [replaySnap, setReplaySnap] = useState<TopoSnapshot | null>(null);
  const [replayT, setReplayT] = useState<number | null>(null);

  const loadRecording = useCallback(async (): Promise<ReplayRecording | null> => {
    if (!incident || !detail) return null;
    setRecState({ status: 'loading' });
    try {
      const w = replayWindow(incident, clock.liveNow() - 3000, REPLAY_MAX_RANGE_MS);
      // Only services this user may see: the server refuses the whole request if any one is out of scope,
      // and an incident can span teams (a payments viewer still gets the payments part of the recording).
      const mine = involved.filter((sid) => isServiceId(sid) && teams.includes(SERVICE_BY_ID[sid].team));
      if (!mine.length) throw new Error('None of the services in this incident belong to your teams');
      const res = await api.get<ReplayResponse>('/replay', { from: w.from, to: w.to, services: mine.join(',') });
      const r = new ReplayRecording(res, detail.alerts, (nodeId) => registry.idxByNodeId.get(nodeId));
      setRec(r);
      setRecState({ status: 'ready' });
      return r;
    } catch (err) {
      setRecState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load the recording' });
      return null;
    }
  }, [incident, detail, involved, teams]);

  // A resolved incident opens straight into its recording, paused at the first alert.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || !incident || !detail || !topoData || open) return;
    autoOpened.current = true;
    void loadRecording().then((r) => r && clock.startReplay(Math.max(r.from, incident.startedAt - 5000), { speed: 4 }));
  }, [incident, detail, topoData, open, loadRecording]);
  // Leaving the room always returns the app to live.
  useEffect(() => () => clock.goLive(), []);

  /** Enters replay (loading or extending the recording first when the incident is still running). */
  const enterReplay = useCallback(
    async (t?: number, play = false) => {
      let r = rec;
      if (!r || (open && !replaying)) r = await loadRecording();
      if (!r) return;
      const at = Math.min(r.to, Math.max(r.from, t ?? r.from));
      if (clock.mode === 'replay') {
        clock.seek(at);
        if (play) clock.play();
      } else clock.startReplay(at, { playing: play, speed: clock.speed === 1 ? 4 : clock.speed });
    },
    [rec, open, replaying, loadRecording],
  );
  const goLive = useCallback(() => {
    clock.goLive();
    setReplaySnap(null);
    setReplayT(null);
  }, []);

  // The replay loop: reconstruct the frame when the recorded second changes, move the scrubber and chart
  // cursor every animation frame, and push React-visible state at most ~8 times a second.
  useEffect(() => {
    if (!rec || !replaying) return;
    let raf = 0;
    let lastSec = -1;
    let lastPush = 0;
    const loop = () => {
      let t = clock.now();
      if (t >= rec.to) {
        if (open && clock.playing) {
          goLive(); // played past the recording of a running incident: carry on live
          return;
        }
        if (clock.playing) clock.pause();
        clock.seek(rec.to);
        t = rec.to;
      } else if (t < rec.from) {
        clock.seek(rec.from);
        t = rec.from;
      }
      const sec = Math.floor(t / 1000);
      scrubber.current?.update(t);
      store.markDirty(REPLAY_CHART_KEY);
      if (sec !== lastSec) {
        lastSec = sec;
        rec.frameAt(t, replayFleet, registry.size);
        store.markDirty(REPLAY_FLEET_KEY);
        const wall = performance.now();
        if (wall - lastPush > 120 || !clock.playing) {
          lastPush = wall;
          setReplaySnap(rec.snapshotAt(t));
          setReplayT(sec * 1000);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rec, replaying, open, goLive, replayFleet]);

  // ---- what the map shows
  // The overlay shows the incident's final epicenter, so in replay it appears from the moment that answer
  // was reached (the last "epicenter" entry); earlier guesses stay visible in the timeline.
  const epicenterAt = useMemo(() => {
    const e = timeline.filter((x) => x.kind === 'epicenter').at(-1);
    return e?.ts ?? incident?.startedAt ?? 0;
  }, [timeline, incident]);
  const view = useMemo(() => {
    const edges = topoData?.edges ?? [];
    if (!incident) return incidentView(null, edges);
    if (replaying) return incidentView(replayT !== null && replayT >= epicenterAt ? incident : null, edges);
    return incidentView(open ? incident : null, edges);
  }, [incident, topoData, replaying, replayT, epicenterAt, open]);

  // ---- chart
  const metric = useMemo(() => incidentMetric(detail?.alerts ?? []), [detail]);
  const mv = METRIC_VIEW[metric];
  const epi = incident?.epicenter && isServiceId(incident.epicenter) ? SERVICE_BY_ID[incident.epicenter] : null;
  const replaySeries = useMemo(() => {
    if (!rec || !epi) return null;
    const s = rec.serviceSeries(epi.idx, metric);
    return { t: s.t, series: [{ label: epi.name, values: s.v, colorVar: '--color-series-1' }] };
  }, [rec, epi, metric]);
  const markers = useMemo(() => (detail?.alerts ?? []).map((a) => a.startedAt), [detail]);
  const liveSeries = useSeries(!replaying && open && epi ? room.service(epi.id) : null, 10 * 60_000);

  const seek = useCallback((t: number) => void enterReplay(t, false), [enterReplay]);

  // ---------------------------------------------------------------------------------------- render
  const back = (
    <Link to="/incidents" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft aria-hidden className="size-4" />
      Incidents
    </Link>
  );
  if (loadError && !incident) {
    return (
      <>
        {back}
        <EmptyState page
          icon={<SearchX aria-hidden className="size-6" />}
          title={loadError.status === 404 ? 'Incident not found' : 'Could not load the incident'}
          body={loadError.status === 404 ? 'It does not exist, or it does not involve any of your teams.' : loadError.message}
        />
      </>
    );
  }
  if (!incident || !topoData || !subTopology) {
    return (
      <>
        {back}
        <div className="flex min-h-64 items-center justify-center text-sm text-muted" role="status">
          Loading incident…
        </div>
      </>
    );
  }

  const win = rec ? { from: rec.from, to: rec.to } : replayWindow(incident, clock.liveNow(), REPLAY_MAX_RANGE_MS);
  const snapshot = replaying && replaySnap ? replaySnap : liveSnap;

  return (
    <>
      {back}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-2 text-sm">
            {open ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-crit/15 px-2 py-0.5 text-crit">
                <Siren aria-hidden className="size-3.5" />
                Open
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/15 px-2 py-0.5 text-ok">
                <CircleCheck aria-hidden className="size-3.5" />
                Resolved
              </span>
            )}
            <span className="text-muted">
              started <span className="metric">{clockTime(incident.startedAt)}</span> ·{' '}
              {open ? `open ${duration(clock.liveNow() - incident.startedAt)}` : `lasted ${duration((incident.endedAt ?? incident.startedAt) - incident.startedAt)}`}
            </span>
          </p>
          <h1 className="page-title page-title-content text-lg [overflow-wrap:anywhere] sm:text-xl">{incident.title || 'Incident'}</h1>
          <p className="mt-1 text-sm text-muted">
            Epicenter <span className="font-medium text-fg">{nameOf(incident.epicenter)}</span> · {Math.round(incident.confidence * 100)}% confidence ·{' '}
            {incident.affected.length} alerting, {incident.blastRadius.filter((s) => s !== incident.epicenter).length} in the blast radius
          </p>
        </div>
        <Presence users={users} />
      </header>

      <section data-tour="replay-controls" className="card mb-4 p-4" aria-label="Replay controls">
        {recState.status === 'error' ? (
          <p className="text-sm text-muted">
            {recState.message}{' '}
            <button type="button" onClick={() => void enterReplay()} className="text-accent hover:text-accent-strong">
              Try again
            </button>
          </p>
        ) : (
          <TimeScrubber
            ref={scrubber}
            from={win.from}
            to={win.to}
            startedAt={incident.startedAt}
            alerts={detail?.alerts ?? []}
            ready={!!detail && recState.status !== 'loading'}
            canGoLive={open}
            onSeek={seek}
            onPlay={() => void enterReplay(replaying ? clock.now() >= win.to - 1000 ? win.from : clock.now() : undefined, true)}
            onPause={() => clock.pause()}
            onSpeed={(s) => clock.setSpeed(s)}
            onGoLive={goLive}
            onRestart={() => void enterReplay(win.from, replaying && playing)}
          />
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card min-w-0 self-start">
          <header className="flex min-h-11 items-center justify-between border-b border-line px-4 py-2">
            <h2 className="panel-title">Topology</h2>
            <span className="text-xs text-muted">{replaying ? 'Recorded state at the replay position' : 'Live'}</span>
          </header>
          <TopologyMap topology={topoData} snapshot={snapshot} view={view} selected={null} onSelect={() => {}} />
        </section>

        <div className="flex flex-col gap-4">
          {detail?.chaos && (
            <Panel
              title="Chaos scorecard"
              tour="incident-scorecard"
              actions={<FlaskConical aria-hidden className="size-4 text-muted" />}
            >
              <Scorecard card={detail.chaos} />
            </Panel>
          )}
          <Panel title="Timeline" tour="incident-timeline" className="h-[26rem]">
            <Timeline
              entries={timeline}
              replayT={replaying ? replayT : null}
              onSeek={seek}
              canNote={hasRole(user, 'admin', 'sre')}
              incidentId={id}
            />
          </Panel>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel title={`${epi?.name ?? 'Epicenter'} · ${mv.title}`} actions={<span className="text-xs text-muted">{mv.unit}</span>}>
          <div className="px-3 pb-2 pt-3">
            {replaying || !open ? (
              replaySeries ? (
                <ReplayChart
                  t={replaySeries.t}
                  series={replaySeries.series}
                  unit={mv.unit}
                  drawKey={REPLAY_CHART_KEY}
                  markers={markers}
                  onSeek={seek}
                  ariaLabel={`${epi?.name} ${mv.title} across the recorded window. Click to replay from a moment.`}
                />
              ) : (
                <p className="py-16 text-center text-sm text-muted">{recState.status === 'loading' ? 'Loading recording…' : 'Press Replay to load the recording.'}</p>
              )
            ) : liveSeries.buffer && liveSeries.key ? (
              <LiveChart
                buffer={liveSeries.buffer}
                drawKey={liveSeries.key}
                series={[{ label: epi?.name ?? 'Epicenter', column: mv.col, colorVar: '--color-series-1' }]}
                rangeMs={10 * 60_000}
                stepMs={1000}
                unit={mv.unit}
                syncKey={`incident:${id}`}
                ariaLabel={`${epi?.name} ${mv.title}, live, last 10 minutes`}
              />
            ) : (
              <p className="py-16 text-center text-sm text-muted">Waiting for the epicenter to be identified.</p>
            )}
          </div>
        </Panel>
        <Panel title="Nodes involved" actions={<span className="text-xs text-muted">{replaying ? 'Recorded' : 'Live'}</span>}>
          <div className="p-4">
            {subTopology.nodes.length ? (
              <FleetHeatmap
                topology={subTopology}
                {...(replaying ? { state: replayFleet, drawKey: REPLAY_FLEET_KEY } : {})}
              />
            ) : (
              <p className="py-12 text-center text-sm text-muted">None of the involved nodes belong to your teams.</p>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
