// Pure geometry and incident state for the topology map, kept out of the component so it is testable.
import { transitiveDependents, type ServiceId } from '@epicenter/shared';

export interface LayoutService {
  id: string;
  layer: number;
  dependsOn: string[];
}

export interface Placed {
  id: string;
  x: number;
  y: number;
}

/**
 * Fixed layered layout: one row per `layer`, callers above callees. Within a row, services are ordered
 * by the mean position of their callers in the row above (barycentre), which keeps edges from crossing
 * where the graph allows it. Services nobody calls go to the right. Coordinates are node centres.
 */
export function layoutLayers(services: LayoutService[], colGap = 220, rowGap = 160): Placed[] {
  const callers = new Map<string, string[]>();
  for (const s of services) for (const d of s.dependsOn) callers.set(d, [...(callers.get(d) ?? []), s.id]);
  const layers = [...new Set(services.map((s) => s.layer))].sort((a, b) => a - b);
  const x = new Map<string, number>();
  const out: Placed[] = [];

  for (const layer of layers) {
    const row = services.filter((s) => s.layer === layer);
    const key = (s: LayoutService, i: number) => {
      const xs = (callers.get(s.id) ?? []).map((c) => x.get(c)).filter((v): v is number => v !== undefined);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1e9 + i;
    };
    const ordered = row.map((s, i) => ({ s, k: key(s, i), i })).sort((a, b) => a.k - b.k || a.i - b.i);
    ordered.forEach(({ s }, i) => {
      const cx = (i - (ordered.length - 1) / 2) * colGap;
      x.set(s.id, cx);
      out.push({ id: s.id, x: cx, y: layer * rowGap });
    });
  }
  return out;
}

export interface IncidentView {
  epicenter: string | null;
  /** Services that transitively depend on the epicenter (excluding it). */
  blast: Set<string>;
  /** Services with alerts in the incident. */
  affected: Set<string>;
  /** Edge ids ("from>to") on the paths the failure spreads along: callee in blast ∪ {epicenter}, caller in blast. */
  spreadEdges: Set<string>;
}

export const edgeId = (from: string, to: string): string => `${from}>${to}`;

export function incidentView(
  incident: { epicenter: string | null; blastRadius: string[]; affected: string[] } | null,
  edges: { from: string; to: string }[],
): IncidentView {
  if (!incident?.epicenter) {
    return { epicenter: null, blast: new Set(), affected: new Set(incident?.affected ?? []), spreadEdges: new Set() };
  }
  const epi = incident.epicenter;
  // The server sends blastRadius; derive it from the graph if it is missing, so the map never goes blank.
  const blast = new Set(incident.blastRadius.length ? incident.blastRadius : [...transitiveDependents(epi as ServiceId)]);
  blast.delete(epi);
  const reach = new Set([...blast, epi]);
  const spreadEdges = new Set(edges.filter((e) => blast.has(e.from) && reach.has(e.to)).map((e) => edgeId(e.from, e.to)));
  return { epicenter: epi, blast, affected: new Set(incident.affected), spreadEdges };
}

/** Stroke width for an edge carrying `rps`, relative to the busiest edge (area-like: square root). */
export function edgeWidth(rps: number, maxRps: number): number {
  if (!(maxRps > 0) || !(rps > 0)) return 1.25;
  return 1.25 + 4.75 * Math.sqrt(Math.min(1, rps / maxRps));
}
