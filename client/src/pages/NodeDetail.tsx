import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BellOff, CircleCheck, OctagonAlert, SearchX, TriangleAlert } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { METRICS, SERVICE_BY_ID, isServiceId, room, type AlertDTO } from '@epicenter/shared';
import { EmptyState } from '../components/EmptyState';
import { LiveChart, type ChartGhost, type ChartSeries } from '../components/LiveChart';
import { Panel } from '../components/Panel';
import { STATUS_VIEW, StatusIcon } from '../components/StatusIcon';
import { useTopology } from '../data/hooks';
import { fleet, topology as registry } from '../data/live';
import { useRoom } from '../data/useRoom';
import { useSeries, type UseSeries } from '../data/useSeries';
import { clockTime, duration } from '../lib/format';
import { useAlerts } from '../state/alertStore';

const RANGES = [
  { id: '5m', label: '5 m', ms: 5 * 60_000 },
  { id: '15m', label: '15 m', ms: 15 * 60_000 },
  { id: '1h', label: '1 h', ms: 60 * 60_000 },
  { id: '6h', label: '6 h', ms: 6 * 60 * 60_000 },
] as const;
const HOUR = 60 * 60_000;
const col = (m: (typeof METRICS)[number]) => METRICS.indexOf(m);

interface ChartDef {
  title: string;
  unit: string;
  series: ChartSeries[];
  yMax?: number;
  yFloor?: number;
}

const CHARTS: ChartDef[] = [
  {
    title: 'CPU and memory',
    unit: '%',
    yMax: 100,
    series: [
      { label: 'CPU', column: col('cpu'), colorVar: '--color-series-1' },
      { label: 'Memory', column: col('mem'), colorVar: '--color-series-2' },
    ],
  },
  { title: 'Latency', unit: 'ms', yFloor: 20, series: [{ label: 'Latency', column: col('lat'), colorVar: '--color-series-1' }] },
  { title: 'Errors', unit: '%', yFloor: 2, series: [{ label: 'Error rate', column: col('err'), colorVar: '--color-series-1' }] },
  {
    title: 'Network',
    unit: 'kB/s',
    yFloor: 100,
    series: [
      { label: 'In', column: col('netIn'), colorVar: '--color-series-1' },
      { label: 'Out', column: col('netOut'), colorVar: '--color-series-2' },
    ],
  },
];

/** Node status from the fleet state, refreshed once a second. −1 = no data yet. */
function useNodeStatus(nodeIdx: number | undefined): number {
  const [status, setStatus] = useState(-1);
  useEffect(() => {
    const read = () => setStatus(nodeIdx !== undefined && fleet.seen[nodeIdx] ? fleet.status[nodeIdx]! : -1);
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [nodeIdx]);
  return status;
}

function ChartCard({ def, main, ghost, rangeMs, syncKey }: { def: ChartDef; main: UseSeries; ghost: ChartGhost | null; rangeMs: number; syncKey: string }) {
  const { state, buffer, key } = main;
  return (
    <Panel
      title={def.title}
      actions={
        <span className="flex items-center gap-3 text-xs text-muted">
          {ghost && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="w-5 border-t-2 border-dashed border-faint" />
              {def.series[0]!.label} 1 h earlier
            </span>
          )}
          {def.unit}
        </span>
      }
    >
      <div className="relative min-h-[226px] px-3 pb-2 pt-3">
        {buffer && key && (
          <LiveChart
            buffer={buffer}
            drawKey={key}
            series={def.series}
            rangeMs={rangeMs}
            stepMs={main.res === '1m' ? 60_000 : 1000}
            unit={def.unit}
            yMax={def.yMax}
            yFloor={def.yFloor}
            syncKey={syncKey}
            ghost={ghost ? { ...ghost, column: def.series[0]!.column } : null}
            ariaLabel={`${def.title} over the selected range. Move the pointer over the chart to read values.`}
          />
        )}
        {state.status !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/80 text-sm text-muted" role="status">
            {state.status === 'loading' ? (
              'Loading history…'
            ) : (
              <>
                <p>{state.message}</p>
                <button type="button" onClick={main.reload} className="text-accent hover:text-accent-strong">
                  Try again
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function AlertHistory({ alerts }: { alerts: AlertDTO[] }) {
  if (!alerts.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <BellOff aria-hidden className="size-6 text-faint" />
        <p className="text-sm text-fg">No alerts for this node</p>
        <p className="text-sm text-muted">Nothing has fired on it in the recent history.</p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {alerts.map((a) => {
        const resolved = a.state === 'resolved';
        const Icon = resolved ? CircleCheck : a.severity === 'crit' ? OctagonAlert : TriangleAlert;
        const tone = resolved ? 'text-faint' : a.severity === 'crit' ? 'text-crit' : 'text-warn';
        return (
          <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
            <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
            <div className="min-w-0 flex-1">
              <p className={`text-sm [overflow-wrap:anywhere] ${resolved ? 'text-muted' : 'text-fg'}`}>
                <span className="sr-only">{resolved ? 'Resolved' : a.severity === 'crit' ? 'Critical' : 'Warning'}: </span>
                {a.message}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                <span className="metric">{clockTime(a.startedAt)}</span> ·{' '}
                {resolved && a.resolvedAt ? `resolved after ${duration(a.resolvedAt - a.startedAt)}` : a.state === 'acked' ? `acknowledged${a.ackedBy ? ` by ${a.ackedBy}` : ''}` : 'firing'}
                {a.incidentId && (
                  <>
                    {' · '}
                    <Link to={`/incidents/${a.incidentId}`} className="text-accent hover:text-accent-strong">
                      incident
                    </Link>
                  </>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function NodeDetail() {
  const { id = '' } = useParams();
  const topo = useTopology();
  const nodeIdx = topo ? registry.idxByNodeId.get(id) : undefined;
  const node = nodeIdx !== undefined ? registry.nodeByIdx[nodeIdx] : undefined;
  const service = node && isServiceId(node[2]) ? SERVICE_BY_ID[node[2]] : undefined;

  const [rangeId, setRangeId] = useState<(typeof RANGES)[number]['id']>('15m');
  const [compare, setCompare] = useState(false);
  const rangeMs = RANGES.find((r) => r.id === rangeId)!.ms;

  const nodeRoom = node ? room.node(id) : null;
  const main = useSeries(nodeRoom, rangeMs);
  const past = useSeries(compare ? nodeRoom : null, rangeMs, HOUR);
  useRoom(service ? room.fleet(service.team) : null); // keeps the status chip live
  const status = useNodeStatus(nodeIdx);

  const allAlerts = useAlerts((s) => s.alerts);
  const alerts = useMemo(() => allAlerts.filter((a) => a.nodeId === id).slice(0, 50), [allAlerts, id]);

  const ghost: ChartGhost | null = compare && past.buffer && past.key ? { buffer: past.buffer, drawKey: past.key, offsetMs: HOUR, column: 0 } : null;

  const back = (
    <Link to="/" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft aria-hidden className="size-4" />
      Overview
    </Link>
  );

  if (!topo) {
    return (
      <>
        {back}
        <div className="flex min-h-64 items-center justify-center text-sm text-muted" role="status">
          Loading node…
        </div>
      </>
    );
  }
  if (!node) {
    return (
      <>
        {back}
        <EmptyState
          icon={<SearchX aria-hidden className="size-6" />}
          title="Node not found"
          body={`"${id}" is not a registered node, or it belongs to a team you cannot see.`}
        />
      </>
    );
  }

  const st = STATUS_VIEW[status];
  return (
    <>
      {back}
      <header className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="metric truncate text-lg font-semibold tracking-tight sm:text-xl">{id}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5 text-fg">
              {st ? <StatusIcon status={status} /> : null}
              {st ? st.label : 'No data yet'}
            </span>
            <span aria-hidden>·</span>
            {service?.name ?? node[2]}
            <span aria-hidden>·</span>
            {service ? `${service.team} team` : ''}
            <span aria-hidden>·</span>
            {node[4]}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((c) => !c)}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              compare ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line text-muted hover:border-accent hover:text-fg'
            }`}
          >
            Compare with 1 h ago
          </button>
          <div role="radiogroup" aria-label="Time range" className="flex rounded-md border border-line p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={rangeId === r.id}
                onClick={() => setRangeId(r.id)}
                className={`metric rounded px-2.5 py-1 text-sm transition-colors ${
                  rangeId === r.id ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:text-fg'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <p className="mb-3 text-xs text-muted">
        {main.live
          ? 'Live: 1-second points, history and the live stream merged by timestamp.'
          : 'Long range: 1-minute averages, refreshed every 30 seconds.'}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {CHARTS.map((def) => (
          <ChartCard key={def.title} def={def} main={main} ghost={ghost} rangeMs={rangeMs} syncKey={`node:${id}`} />
        ))}
      </div>

      <Panel title="Alert history" className="mt-4">
        <AlertHistory alerts={alerts} />
      </Panel>
    </>
  );
}
