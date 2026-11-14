import { useCallback, useEffect, useMemo, useState } from 'react';
import { Server } from 'lucide-react';
import { SERVICE_BY_ID, room } from '@epicenter/shared';
import { AlertFeed } from '../components/AlertFeed';
import { EmptyState } from '../components/EmptyState';
import { FleetHeatmap, HeatmapLegend } from '../components/FleetHeatmap';
import { IncidentBanner } from '../components/IncidentBanner';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { StatTile } from '../components/StatTile';
import { useTopology } from '../data/hooks';
import { fleet, reloadTopology, topo, visibleTeams } from '../data/live';
import { useRoom, useRooms } from '../data/useRoom';
import { compact, ms } from '../lib/format';
import { useAuth } from '../state/authStore';
import { selectOpenIncidents, useIncidents } from '../state/incidentStore';

const GATEWAY = SERVICE_BY_ID['edge-gateway'].idx;

interface Summary {
  /** [ok, warn, crit, silent] among the nodes that have reported. */
  counts: [number, number, number, number];
  rps: number;
  lat: number;
  rpsTrend: number[];
  latTrend: number[];
  hasTopo: boolean;
}

/**
 * Headline numbers, read from the typed-array state once a second. This is the only place Overview
 * telemetry touches React state: a handful of numbers at 1 Hz, not the stream.
 */
function useSummary(): Summary {
  const read = (): Summary => ({
    counts: fleet.statusCounts(),
    rps: topo.rps[GATEWAY]!,
    lat: topo.latP95[GATEWAY]!,
    rpsTrend: topo.rpsHistory[GATEWAY]!.toArray(),
    latTrend: topo.latHistory[GATEWAY]!.toArray(),
    hasTopo: topo.tsSec > 0,
  });
  const [summary, setSummary] = useState(read);
  useEffect(() => {
    let seen = -1;
    const tick = () => {
      const v = fleet.version * 1e6 + topo.version;
      if (v === seen) return;
      seen = v;
      setSummary(read());
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return summary;
}

export function Overview() {
  const user = useAuth((s) => s.user);
  const topology = useTopology();
  const teams = useMemo(() => visibleTeams(user), [user]);
  useRooms(useMemo(() => teams.map((t) => room.fleet(t)), [teams]));
  useRoom(room.topology);

  const s = useSummary();
  const openIncidents = useIncidents((st) => selectOpenIncidents(st).length);
  const incidentsStatus = useIncidents((st) => st.status);
  const incidentsReady = incidentsStatus === 'ready';
  const [topoError, setTopoError] = useState(false);
  const giveUp = useCallback(() => setTopoError(true), []);

  const total = topology?.nodes.length ?? 0;
  const reporting = s.counts[0] + s.counts[1] + s.counts[2] + s.counts[3];
  const unhealthy = s.counts[1] + s.counts[2] + s.counts[3];
  const lat = ms(s.lat);
  const scope = user?.role === 'viewer' ? `${teams.join(', ')} team` : 'All teams';

  return (
    <>
      <PageHeader title="Overview" subtitle={`${scope} · ${total ? `${total} nodes` : 'loading fleet'}`} />
      <IncidentBanner />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label="Nodes healthy"
          value={reporting ? String(s.counts[0]) : '–'}
          unit={total ? `of ${total}` : undefined}
          hint={!reporting ? 'Waiting for data' : unhealthy ? `${unhealthy} need attention` : 'All reporting normally'}
        />
        <StatTile label="Ingress traffic" value={s.hasTopo ? compact(s.rps) : '–'} unit="req/s" trend={s.rpsTrend} hint="Edge gateway, last minute" />
        <StatTile label="Gateway latency p95" value={s.hasTopo ? lat.value : '–'} unit={lat.unit} trend={s.latTrend} hint="End to end, last minute" />
        <StatTile
          label="Open incidents"
          value={incidentsReady ? String(openIncidents) : '–'}
          hint={
            incidentsStatus === 'unavailable'
              ? 'Not available on this server yet'
              : incidentsStatus === 'error'
                ? 'Could not load'
                : !incidentsReady
                  ? 'Loading'
                  : openIncidents
                    ? 'See the banner above'
                    : 'None right now'
          }
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Fleet" className="xl:col-span-2">
          <div className="p-4">
            {topology && total > 0 ? (
              <>
                <FleetHeatmap topology={topology} />
                <div className="mt-4 border-t border-line pt-3">
                  <HeatmapLegend counts={s.counts} />
                </div>
              </>
            ) : topology ? (
              <EmptyState icon={<Server aria-hidden className="size-6" />} title="No nodes to show" body="None of the registered nodes belong to your teams." />
            ) : topoError ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
                <p>Could not load the fleet.</p>
                <button
                  type="button"
                  className="text-accent hover:text-accent-strong"
                  onClick={() => {
                    setTopoError(false);
                    reloadTopology().catch(() => setTopoError(true));
                  }}
                >
                  Try again
                </button>
              </div>
            ) : (
              <TopologyLoading onGiveUp={giveUp} />
            )}
          </div>
        </Panel>
        {/* The feed takes the height of the fleet panel beside it and scrolls inside. */}
        <div className="relative h-[30rem] xl:h-auto xl:min-h-[30rem]">
          <div className="absolute inset-0">
            <AlertFeed />
          </div>
        </div>
      </div>
    </>
  );
}

/** Loading state that turns into an error with a retry if the topology has not arrived after a while. */
function TopologyLoading({ onGiveUp }: { onGiveUp: () => void }) {
  useEffect(() => {
    const t = setTimeout(onGiveUp, 8000);
    return () => clearTimeout(t);
  }, [onGiveUp]);
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-muted" role="status">
      Loading fleet…
    </div>
  );
}
