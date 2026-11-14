import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Network, Siren } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { SERVICES, SERVICE_BY_ID, isServiceId, room, type IncidentDTO } from '@epicenter/shared';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { Sparkline } from '../components/Sparkline';
import { STATUS_VIEW, StatusIcon } from '../components/StatusIcon';
import { TopologyMap } from '../components/TopologyMap';
import { useTopology } from '../data/hooks';
import { fleet, topo, topology as registry, visibleTeams } from '../data/live';
import { useRoom, useRooms } from '../data/useRoom';
import { useTopoSnapshot, type TopoSnapshot } from '../data/useTopoSnapshot';
import { clockTime, compact, duration, ms } from '../lib/format';
import { incidentView } from '../lib/topologyView';
import { useAuth } from '../state/authStore';
import { selectOpenIncidents, useIncidents } from '../state/incidentStore';

const nameOf = (id: string) => (isServiceId(id) ? SERVICE_BY_ID[id].name : id);

function IncidentPanel({ incident, now }: { incident: IncidentDTO; now: number }) {
  const blast = incident.blastRadius.filter((s) => s !== incident.epicenter);
  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex items-start gap-2">
        <Siren aria-hidden className="mt-0.5 size-4 shrink-0 text-crit" />
        <p className="font-medium [overflow-wrap:anywhere]">{incident.title || 'Incident open'}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-muted">
        <dt>Epicenter</dt>
        <dd className="text-fg">{incident.epicenter ? nameOf(incident.epicenter) : 'Locating…'}</dd>
        <dt>Confidence</dt>
        <dd className="metric text-fg">{Math.round(incident.confidence * 100)}%</dd>
        <dt>Started</dt>
        <dd>
          <span className="metric text-fg">{clockTime(incident.startedAt)}</span> · {duration(now - incident.startedAt)} ago
        </dd>
        <dt>Alerting</dt>
        <dd className="text-fg">{incident.affected.map(nameOf).join(', ') || '–'}</dd>
        <dt>Blast radius</dt>
        <dd className="text-fg">{blast.length ? blast.map(nameOf).join(', ') : 'Nothing depends on it'}</dd>
      </dl>
      <Link
        to={`/incidents/${incident.id}`}
        className="btn px-3 text-fg"
      >
        Open incident room
      </Link>
    </div>
  );
}

/** Live numbers and member nodes for one service. Fleet status is read at 1 Hz. */
function ServicePanel({ serviceId, snapshot }: { serviceId: string; snapshot: TopoSnapshot }) {
  const def = isServiceId(serviceId) ? SERVICE_BY_ID[serviceId] : null;
  const live = def ? snapshot.services[def.idx] : undefined;
  const topoData = useTopology();
  const members = useMemo(() => (topoData?.nodes ?? []).filter((n) => n[2] === serviceId), [topoData, serviceId]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!def || !live) return null;
  const has = snapshot.tsSec > 0;
  const lat = ms(live.lat);
  const st = STATUS_VIEW[live.status] ?? STATUS_VIEW[0]!;

  return (
    <div className="p-4 text-sm">
      <p className="flex items-center gap-1.5 font-medium">
        <StatusIcon status={live.status} />
        {def.name}
        <span className="font-normal text-muted">· {def.team} team · {st.label}</span>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-muted">Traffic</p>
          <p>
            <span className="metric text-lg font-semibold">{has ? compact(live.rps) : '–'}</span> <span className="text-xs text-muted">req/s</span>
          </p>
          <Sparkline values={topo.rpsHistory[def.idx]!.toArray()} width={120} />
        </div>
        <div>
          <p className="text-xs text-muted">Latency p95 (SLO {def.sloMs} ms)</p>
          <p>
            <span className={`metric text-lg font-semibold ${has && live.lat > def.sloMs ? 'text-warn' : ''}`}>{has ? lat.value : '–'}</span>{' '}
            <span className="text-xs text-muted">{lat.unit}</span>
          </p>
          <Sparkline values={topo.latHistory[def.idx]!.toArray()} width={120} />
        </div>
        <div>
          <p className="text-xs text-muted">CPU avg</p>
          <p className="metric">{has ? `${Math.round(live.cpu)}%` : '–'}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Errors avg</p>
          <p className="metric">{has ? `${live.err.toFixed(1)}%` : '–'}</p>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">
        Nodes {members.length ? `(${members.length} you can see)` : ''}
      </p>
      {members.length ? (
        <ul className="mt-1 max-h-48 overflow-y-auto">
          {members.map(([idx, nodeId]) => {
            const s = fleet.seen[idx] ? fleet.status[idx]! : -1;
            return (
              <li key={nodeId}>
                <Link to={`/node/${encodeURIComponent(nodeId)}`} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-raised">
                  {s >= 0 ? <StatusIcon status={s} className="size-3.5" /> : <span className="size-3.5" />}
                  <span className="metric truncate text-xs text-accent">{nodeId}</span>
                  {s >= 0 && <span className="ml-auto shrink-0 text-xs text-muted">CPU {fleet.cpu[idx]}%</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted">None of its nodes belong to your teams.</p>
      )}
    </div>
  );
}

/** Text view of the map: every service with its live numbers. Also the keyboard path to a service. */
function ServiceTable({ snapshot, onSelect, selected }: { snapshot: TopoSnapshot; onSelect: (id: string) => void; selected: string | null }) {
  const has = snapshot.tsSec > 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-normal">Service</th>
            <th className="px-2 py-2 font-normal">Status</th>
            <th className="px-2 py-2 text-right font-normal">req/s</th>
            <th className="px-2 py-2 text-right font-normal">p95</th>
            <th className="px-2 py-2 text-right font-normal">Errors</th>
            <th className="px-4 py-2 text-right font-normal">Healthy</th>
          </tr>
        </thead>
        <tbody>
          {SERVICES.map((s) => {
            const live = snapshot.services[s.idx]!;
            const st = STATUS_VIEW[live.status] ?? STATUS_VIEW[0]!;
            const lat = ms(live.lat);
            return (
              <tr key={s.id} className={`border-b border-line last:border-0 ${selected === s.id ? 'bg-accent-soft' : ''}`}>
                <td className="px-4 py-1.5">
                  <button type="button" onClick={() => onSelect(s.id)} className="text-left text-fg hover:text-accent-strong">
                    {s.name}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <span className="inline-flex items-center gap-1.5 text-muted">
                    <StatusIcon status={live.status} className="size-3.5" />
                    {has ? st.label : '–'}
                  </span>
                </td>
                <td className="metric px-2 py-1.5 text-right">{has ? compact(live.rps) : '–'}</td>
                <td className={`metric px-2 py-1.5 text-right ${has && live.lat > s.sloMs ? 'text-warn' : ''}`}>{has ? `${lat.value} ${lat.unit}` : '–'}</td>
                <td className="metric px-2 py-1.5 text-right">{has ? `${live.err.toFixed(1)}%` : '–'}</td>
                <td className="metric px-4 py-1.5 text-right">{has ? `${live.healthy}/${live.total}` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Legend({ incident }: { incident: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3 text-xs text-muted">
      <li className="inline-flex items-center gap-2">
        <svg width="34" height="10" aria-hidden>
          <line x1="0" y1="3" x2="34" y2="3" stroke="var(--color-faint)" strokeWidth="1.5" />
          <line x1="0" y1="8" x2="34" y2="8" stroke="var(--color-faint)" strokeWidth="4" />
        </svg>
        Edge width = traffic (caller → callee)
      </li>
      {incident && (
        <>
          <li className="inline-flex items-center gap-2">
            <svg width="34" height="10" aria-hidden>
              <line x1="0" y1="5" x2="34" y2="5" stroke="var(--color-crit)" strokeWidth="3" strokeDasharray="8 4" />
            </svg>
            Failure spreading from the epicenter
          </li>
          <li>Dimmed = outside the blast radius</li>
        </>
      )}
      {STATUS_VIEW.map((s, i) => (
        <li key={s.name} className="inline-flex items-center gap-1.5">
          <StatusIcon status={i} className="size-3.5" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function Topology() {
  const user = useAuth((s) => s.user);
  const topoData = useTopology();
  useRoom(room.topology);
  const teams = useMemo(() => visibleTeams(user), [user]);
  useRooms(useMemo(() => teams.map((t) => room.fleet(t)), [teams])); // node statuses in the service panel

  const snapshot = useTopoSnapshot();
  const open = useIncidents(useShallow(selectOpenIncidents));
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const incident = open.find((i) => i.id === incidentId) ?? open[0] ?? null;
  const [selected, setSelected] = useState<string | null>(null);

  const view = useMemo(() => incidentView(incident, topoData?.edges ?? []), [incident, topoData]);
  const now = snapshot.tsSec ? snapshot.tsSec * 1000 : Date.now();

  if (!topoData) {
    return (
      <>
        <PageHeader title="Topology" subtitle="Service dependency map and blast radius" />
        <div className="flex min-h-64 items-center justify-center text-sm text-muted" role="status">
          Loading topology…
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Topology"
        subtitle={`${topoData.services.length} services · ${registry.data?.nodes.length ?? 0} nodes you can see · live, once a second`}
        actions={
          open.length > 1 ? (
            <label className="flex items-center gap-2 text-sm text-muted">
              Incident
              <select
                value={incident?.id ?? ''}
                onChange={(e) => setIncidentId(e.target.value)}
                className="field max-w-64 bg-surface px-2 py-1.5"
              >
                {open.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title || i.id}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined
        }
      />

      {incident?.epicenter && (
        <p role="status" className="mb-3 flex flex-wrap items-center gap-x-2 rounded-lg border border-crit/40 bg-crit/10 px-4 py-2.5 text-sm">
          <Siren aria-hidden className="size-4 shrink-0 text-crit" />
          <span>
            Epicenter <span className="font-semibold">{nameOf(incident.epicenter)}</span>, spreading to{' '}
            {view.blast.size ? `${view.blast.size} dependent service${view.blast.size === 1 ? '' : 's'}` : 'nothing else'} ·{' '}
            {Math.round(incident.confidence * 100)}% confidence
          </span>
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section data-tour="topo-map" className="card min-w-0 self-start">
          <TopologyMap topology={topoData} snapshot={snapshot} view={view} selected={selected} onSelect={setSelected} />
          <div className="border-t border-line">
            <Legend incident={!!incident?.epicenter} />
          </div>
        </section>

        <div className="space-y-4">
          {selected ? (
            <Panel
              title="Service"
              actions={
                <button type="button" onClick={() => setSelected(null)} className="text-xs text-muted hover:text-fg">
                  Close
                </button>
              }
            >
              <ServicePanel serviceId={selected} snapshot={snapshot} />
            </Panel>
          ) : null}
          <Panel title="Incident" tour="topo-incident">
            {incident ? (
              <IncidentPanel incident={incident} now={now} />
            ) : (
              <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
                <CircleCheck aria-hidden className="size-6 text-ok" />
                <p className="text-sm text-fg">No open incident</p>
                <p className="text-sm text-muted">When alerts cascade, the epicenter and its blast radius are traced here.</p>
              </div>
            )}
          </Panel>
          {!selected && (
            <p className="flex items-center gap-2 px-1 text-xs text-muted">
              <Network aria-hidden className="size-3.5" />
              Select a service on the map or in the table for its numbers and nodes.
            </p>
          )}
        </div>
      </div>

      <Panel title="Services" className="mt-4">
        {snapshot.tsSec ? (
          <ServiceTable snapshot={snapshot} onSelect={setSelected} selected={selected} />
        ) : (
          <EmptyState title="Waiting for the first update" body="Service numbers arrive once a second." />
        )}
      </Panel>
    </>
  );
}
