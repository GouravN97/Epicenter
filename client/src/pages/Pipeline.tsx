// Pipeline X-ray (plan §9.1, B9): the platform monitoring itself. The path of an event, stage by stage,
// with live per-second counters and running totals, then trends of throughput, filtering, delay and
// event-loop lag. Stats arrive once a second on the `meta` room (meta:pt, §8.8).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, CircleAlert, FlaskConical, Gauge } from 'lucide-react';
import { CHAOS_SCENARIOS, SHED_LAG_P99_MS, room, type PipelineStats } from '@epicenter/shared';
import { LiveChart } from '../components/LiveChart';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { META_KEY, META_WIDTH, delay, fps, pipeline, store, transport, visibleTeams } from '../data/live';
import { metaCol } from '../data/pipelineStats';
import type { SeriesBuffer } from '../data/SeriesBuffer';
import { useRoom, useRooms } from '../data/useRoom';
import { useSocketEvent } from '../data/useSocketEvent';
import { compact } from '../lib/format';
import { hasRole, useAuth } from '../state/authStore';
import { useChaos } from '../state/chaosStore';

const RANGE_MS = 2 * 60_000;
type Totals = Record<'eps' | 'accepted' | 'duplicate' | 'outOfOrder' | 'lateCorrected' | 'stale' | 'rejected' | 'shed429' | 'writeDropped', number>;
const ZERO: Totals = { eps: 0, accepted: 0, duplicate: 0, outOfOrder: 0, lateCorrected: 0, stale: 0, rejected: 0, shed429: 0, writeDropped: 0 };

const bytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${Math.round(n)} B`);
const msOrS = (n: number): string => (!Number.isFinite(n) ? '–' : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

interface Local {
  delayP50: number;
  delayP95: number;
  transportP50: number;
  fps: number | null;
}

/** Latest stats, totals since the page opened, and this browser's numbers, refreshed once a second. */
function usePipeline(): { s: PipelineStats | null; totals: Totals; seconds: number; local: Local } {
  const totals = useRef<Totals>({ ...ZERO });
  const seconds = useRef(0);
  const lastTs = useRef(0);
  const read = () => ({
    s: pipeline.latest,
    totals: { ...totals.current },
    seconds: seconds.current,
    local: { delayP50: delay.quantile(0.5), delayP95: delay.quantile(0.95), transportP50: transport.quantile(0.5), fps: fps.read() },
  });
  const [view, setView] = useState(read);
  useEffect(() => {
    let seen = -1;
    const drawer = store.addDrawer(META_KEY, () => {
      if (pipeline.version === seen) return;
      seen = pipeline.version;
      const s = pipeline.latest;
      if (s && s.ts > lastTs.current) {
        lastTs.current = s.ts;
        seconds.current++;
        for (const k of Object.keys(ZERO) as (keyof Totals)[]) totals.current[k] += s[k];
      }
      setView(read());
    });
    return () => drawer.dispose();
  }, []);
  return view;
}

/** Holds the stats buffer while the page is open, so meta:pt samples are kept for the charts. */
function useMetaBuffer(): SeriesBuffer {
  const [buf] = useState(() => store.acquire(META_KEY, META_WIDTH, 600));
  useEffect(() => () => store.release(META_KEY), []);
  return buf;
}

function Counter({ label, short, value, total, warn, hint }: { label: string; short?: string; value: string; total?: string; warn?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs" title={hint ?? label}>
      <dt className={`truncate ${warn ? 'text-warn' : 'text-muted'}`}>
        {warn && <CircleAlert aria-hidden className="mr-1 inline size-3 -translate-y-px" />}
        {/* Six stages side by side leave little room: a short label there, the full one elsewhere. */}
        {short ? (
          <>
            <span className="xl:hidden">{label}</span>
            <span className="hidden xl:inline" aria-hidden>
              {short}
            </span>
          </>
        ) : (
          label
        )}
      </dt>
      <dd className="metric shrink-0 text-right">
        <span className={warn ? 'text-warn' : 'text-fg'}>{value}</span>
        {total !== undefined && <span className="ml-1.5 text-faint">Σ {total}</span>}
      </dd>
    </div>
  );
}

function Stage({ n, title, sub, headline, unit, children, first }: { n: number; title: string; sub: string; headline: string; unit: string; children: ReactNode; first?: boolean }) {
  return (
    <li className="relative">
      {!first && (
        <>
          <ChevronRight aria-hidden className="absolute -left-3.5 top-1/2 z-10 hidden size-5 -translate-y-1/2 text-accent xl:block" />
          <ChevronDown aria-hidden className="mx-auto -mb-1 -mt-2 block size-5 text-accent xl:hidden" />
        </>
      )}
      <section aria-label={`Stage ${n}: ${title}`} className="h-full rounded-lg border border-line bg-surface p-3">
        <p className="text-[11px] uppercase tracking-wide text-faint">
          {n} · {sub}
        </p>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1.5">
          <span className="metric text-xl font-semibold">{headline}</span> <span className="text-xs text-muted">{unit}</span>
        </p>
        <dl className="mt-2 space-y-1 border-t border-line pt-2">{children}</dl>
      </section>
    </li>
  );
}

export function Pipeline() {
  const user = useAuth((s) => s.user);
  const isAdmin = hasRole(user, 'admin');
  const teams = useMemo(() => visibleTeams(user), [user]);
  useRoom(room.meta);
  // Fleet deltas give this browser's end-to-end delay (source timestamp → screen).
  useRooms(useMemo(() => teams.map((t) => room.fleet(t)), [teams]));
  const buffer = useMetaBuffer();
  const { s, totals, seconds, local } = usePipeline();

  const active = useChaos((st) => st.active);
  const applyChaos = useChaos((st) => st.applyUpdate);
  useSocketEvent('chaos:upd', applyChaos);
  const running = active.map((a) => CHAOS_SCENARIOS.find((d) => d.id === a.scenario)?.name ?? a.scenario);

  const v = (x: number | undefined) => (s && x !== undefined ? compact(x) : '–');
  const t = (k: keyof Totals) => (seconds ? compact(totals[k]) : undefined);
  const charts: { title: string; unit: string; series: { label: string; col: number; colorVar: string }[]; yFloor?: number; note?: string }[] = [
    {
      title: 'Events per second',
      unit: 'ev/s',
      yFloor: 10,
      series: [
        { label: 'Received', col: metaCol('eps'), colorVar: '--color-series-1' },
        { label: 'Accepted', col: metaCol('accepted'), colorVar: '--color-series-2' },
      ],
    },
    {
      title: 'Filtered out per second',
      unit: 'ev/s',
      yFloor: 10,
      series: [
        { label: 'Duplicates', col: metaCol('duplicate'), colorVar: '--color-series-1' },
        { label: 'Rejected or 429', col: metaCol('refused'), colorVar: '--color-series-2' },
      ],
    },
    {
      title: 'End-to-end delay p95',
      unit: 'ms',
      yFloor: 1000,
      note: 'Source timestamp to screen. About 3 s of it is the window the server holds open for late events.',
      series: [
        { label: 'This browser', col: metaCol('localDelayP95'), colorVar: '--color-series-1' },
        { label: 'All browsers', col: metaCol('clientE2eP95'), colorVar: '--color-series-2' },
      ],
    },
    {
      title: 'Event-loop lag p99',
      unit: 'ms',
      yFloor: SHED_LAG_P99_MS * 1.33,
      note: `Ingest starts shedding (429) above ${SHED_LAG_P99_MS} ms.`,
      series: [{ label: 'Loop lag', col: metaCol('loopLagP99'), colorVar: '--color-series-1' }],
    },
  ];

  return (
    <>
      <PageHeader
        title="Pipeline X-ray"
        subtitle={`The platform watching itself, once a second${seconds ? ` · Σ totals since you opened this page (${compact(seconds)} s)` : ''}`}
        actions={
          isAdmin ? (
            <Link
              to="/chaos"
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-accent hover:text-fg"
            >
              <FlaskConical aria-hidden className="size-4" />
              Stress it in the Chaos Lab
            </Link>
          ) : undefined
        }
      />

      {(s?.shedding || running.length > 0) && (
        <div className="mb-4 flex flex-wrap gap-2">
          {s?.shedding && (
            <p role="status" className="inline-flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
              <Gauge aria-hidden className="size-4 text-warn" />
              Shedding load: ingest is answering 429 and agents are backing off.
            </p>
          )}
          {running.length > 0 && (
            <p className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              <FlaskConical aria-hidden className="size-4 text-crit" />
              Chaos running: {running.join(', ')}
            </p>
          )}
        </div>
      )}

      {!s && (
        <p role="status" className="mb-4 text-sm text-muted">
          Waiting for the first stats from the server…
        </p>
      )}

      <ol className="grid gap-2 xl:grid-cols-6 xl:gap-4" aria-label="Path of an event">
        <Stage n={1} first title="Ingest" sub="validate, rate-limit" headline={v(s?.eps)} unit="events/s received">
          <Counter label="Rejected (invalid)" short="Invalid" value={v(s?.rejected)} total={t('rejected')} warn={!!s?.rejected} hint="Failed schema validation or the time window; counted per event." />
          <Counter label="Refused with 429" short="429s" value={v(s?.shed429)} total={t('shed429')} warn={!!s?.shed429} hint="Token bucket empty or the server shedding load; never parsed." />
          <Counter label="Too old" value={v(s?.stale)} total={t('stale')} warn={!!s?.stale} />
        </Stage>
        <Stage n={2} title="Dedup" sub="nodeId · bootId · seq" headline={v(s?.accepted)} unit="events/s accepted">
          <Counter label="Duplicates dropped" short="Dupes" value={v(s?.duplicate)} total={t('duplicate')} warn={!!s?.duplicate} />
          <Counter label="Out of order (kept)" short="Reordered" value={v(s?.outOfOrder)} total={t('outOfOrder')} hint="Arrived after a later seq; accepted and slotted into place." />
        </Stage>
        <Stage n={3} title="Aggregate" sub="1-second buckets" headline={v(s?.bucketsOpen)} unit="buckets open">
          <Counter label="Late corrections" short="Late fixes" value={v(s?.lateCorrected)} total={t('lateCorrected')} hint="A late event updated an already-finalized second (rev + 1)." />
        </Stage>
        <Stage n={4} title="Write" sub="MongoDB bulk upsert" headline={v(s?.writeBatch)} unit="points per batch">
          <Counter label="Write time" value={s ? `${Math.round(s.writeMs)} ms` : '–'} />
          <Counter label="Buffered" value={v(s?.writeBuffer)} />
          <Counter label="Dropped" value={v(s?.writeDropped)} total={t('writeDropped')} warn={!!s?.writeDropped} />
        </Stage>
        <Stage n={5} title="Broadcast" sub="Socket.IO rooms" headline={v(s?.emitsPerSec)} unit="emits/s">
          <Counter label="Bytes out" value={s ? `${bytes(s.bytesOutPerSec)}/s` : '–'} />
          <Counter label="Dashboards" value={v(s?.socketsDash)} />
          <Counter label="Rooms in use" short="Rooms" value={v(s?.rooms)} />
          <Counter label="Loop lag p99" short="Lag p99" value={s ? `${Math.round(s.loopLagP99)} ms` : '–'} warn={!!s && s.loopLagP99 > SHED_LAG_P99_MS} />
        </Stage>
        <Stage n={6} title="This browser" sub="render, measure" headline={msOrS(local.delayP50)} unit="data delay p50">
          <Counter label="Delay p95" value={msOrS(local.delayP95)} hint="Source timestamp to screen, including the server's late-event window." />
          <Counter label="Socket delivery p50" short="Socket p50" value={msOrS(local.transportP50)} hint="Server emit to receipt, for the stats stream." />
          <Counter label="Frame rate" value={local.fps !== null ? `${local.fps} fps` : '–'} />
          <Counter label="All browsers p95" short="All p95" value={s?.clientE2eP95 ? msOrS(s.clientE2eP95) : '–'} hint="Median of the p95 every connected dashboard reports." />
        </Stage>
      </ol>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {charts.map((c) => (
          <Panel key={c.title} title={c.title} actions={<span className="text-xs text-muted">{c.unit}</span>}>
            <div className="px-3 pb-2 pt-3">
              <LiveChart
                buffer={buffer}
                drawKey={META_KEY}
                series={c.series.map((x) => ({ label: x.label, column: x.col, colorVar: x.colorVar }))}
                rangeMs={RANGE_MS}
                stepMs={1000}
                unit={c.unit}
                yFloor={c.yFloor}
                syncKey="pipeline"
                height={170}
                ariaLabel={`${c.title}, last two minutes`}
              />
              {c.note && <p className="mt-1 text-xs text-muted">{c.note}</p>}
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
