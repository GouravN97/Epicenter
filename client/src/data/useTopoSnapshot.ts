import { useEffect, useState } from 'react';
import { SERVICES } from '@epicenter/shared';
import { TOPO_KEY, store, topo } from './live';

export interface ServiceSnapshot {
  cpu: number;
  lat: number;
  err: number;
  rps: number;
  healthy: number;
  total: number;
  status: number;
}

export interface TopoSnapshot {
  /** Second of the newest topo:tick; 0 before the first one. */
  tsSec: number;
  /** Indexed by svcIdx. */
  services: ServiceSnapshot[];
}

function read(): TopoSnapshot {
  return {
    tsSec: topo.tsSec,
    services: SERVICES.map((s) => ({
      cpu: topo.cpuAvg[s.idx]!,
      lat: topo.latP95[s.idx]!,
      err: topo.errAvg[s.idx]!,
      rps: topo.rps[s.idx]!,
      healthy: topo.healthy[s.idx]!,
      total: topo.total[s.idx]!,
      status: topo.status[s.idx]!,
    })),
  };
}

/**
 * Per-service aggregates as React state. topo:tick arrives once a second with nine rows, so this is a
 * handful of numbers at 1 Hz (like the stat tiles), not the telemetry stream. Updates ride the shared
 * animation-frame loop, so they pause with the tab.
 */
export function useTopoSnapshot(): TopoSnapshot {
  const [snap, setSnap] = useState(read);
  useEffect(() => {
    let seen = -1;
    const drawer = store.addDrawer(TOPO_KEY, () => {
      if (topo.version === seen) return;
      seen = topo.version;
      setSnap(read());
    });
    return () => drawer.dispose();
  }, []);
  return snap;
}
