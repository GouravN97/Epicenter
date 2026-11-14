// Service dependency map (plan §9.3). Fixed layered layout from the shared topology; nodes show live
// status, traffic and p95 latency; edge width follows traffic. During an incident the epicenter ripples,
// the edges the failure spreads along animate outward from it, and services outside the blast radius dim.
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { SERVICES, type TopologyResponse } from '@epicenter/shared';
import type { TopoSnapshot } from '../data/useTopoSnapshot';
import { compact, ms } from '../lib/format';
import { edgeId, edgeWidth, layoutLayers, type IncidentView } from '../lib/topologyView';
import { useAppearance } from '../state/displayStore';
import { STATUS_VIEW, StatusIcon } from './StatusIcon';

const NODE_W = 172;
const NODE_H = 84;

type Role = 'epicenter' | 'blast' | 'outside' | 'none';

interface ServiceData extends Record<string, unknown> {
  name: string;
  team: string;
  status: number;
  rps: number;
  lat: number;
  sloMs: number;
  healthy: number;
  total: number;
  hasData: boolean;
  role: Role;
  selected: boolean;
}
type ServiceNodeT = Node<ServiceData, 'service'>;

interface FlowData extends Record<string, unknown> {
  rps: number;
  width: number;
  spread: boolean;
  dim: boolean;
  showLabel: boolean;
}
type FlowEdgeT = Edge<FlowData, 'flow'>;

const BORDER: Record<number, string> = { 0: 'border-line', 1: 'border-warn', 2: 'border-crit', 3: 'border-silent border-dashed' };

const ServiceNode = memo(function ServiceNode({ data }: NodeProps<ServiceNodeT>) {
  const st = STATUS_VIEW[data.status] ?? STATUS_VIEW[0]!;
  const lat = ms(data.lat);
  const overSlo = data.hasData && data.lat > data.sloMs;
  const dim = data.role === 'outside';
  return (
    <div className="relative" style={{ width: NODE_W }}>
      {data.role === 'epicenter' && (
        <>
          <span aria-hidden className="epicenter-ripple" />
          <span aria-hidden className="epicenter-ripple [animation-delay:1s]" />
        </>
      )}
      {/* Opaque even when dimmed, so edges passing behind a card never show through it. */}
      <div aria-hidden className="absolute inset-0 rounded-lg bg-raised" />
      {(data.role === 'epicenter' || data.role === 'blast') && (
        <span
          className={`absolute -top-[22px] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-micro font-semibold uppercase tracking-wide ${
            data.role === 'epicenter' ? 'bg-crit text-bg' : 'border border-crit/60 bg-bg text-crit'
          }`}
        >
          {data.role === 'epicenter' ? 'Epicenter' : 'Blast radius'}
        </span>
      )}
      <div
        className={`relative rounded-lg border-2 px-3 py-2 transition-opacity duration-500 ${dim ? 'opacity-35' : ''} ${
          data.role === 'epicenter' ? 'border-crit' : data.role === 'blast' ? 'border-crit/50' : BORDER[data.status] ?? 'border-line'
        } ${data.selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''}`}
        style={{ height: NODE_H }}
      >
        <Handle type="target" position={Position.Top} isConnectable={false} className="!opacity-0" />
        <div className="flex items-center gap-1.5">
          <StatusIcon status={data.hasData ? data.status : 0} className="size-4" />
          <span className="truncate text-sm font-medium text-fg">{data.name}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-3 text-xs text-muted">
          <span>
            <span className="metric text-fg">{data.hasData ? compact(data.rps) : '–'}</span> req/s
          </span>
          <span className={overSlo ? 'text-warn' : ''}>
            p95 <span className={`metric ${overSlo ? 'text-warn' : 'text-fg'}`}>{data.hasData ? lat.value : '–'}</span> {lat.unit}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">
          {data.hasData ? `${data.healthy}/${data.total} healthy` : 'no data'}
          <span className="sr-only">. Status {st.label}.</span>
        </div>
        <Handle type="source" position={Position.Bottom} isConnectable={false} className="!opacity-0" />
      </div>
    </div>
  );
});

function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<FlowEdgeT>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const d = data!;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={d.spread ? 'spread-edge' : ''}
        style={{
          stroke: d.spread ? 'var(--color-crit)' : 'var(--color-faint)',
          strokeWidth: d.width,
          opacity: d.dim ? 0.25 : 1,
          transition: 'stroke-width 600ms, opacity 500ms',
        }}
      />
      {d.showLabel && d.rps > 0 && (
        <EdgeLabelRenderer>
          <div
            className="metric pointer-events-none absolute rounded bg-bg/85 px-1 text-micro text-muted"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: d.dim ? 0.3 : 1 }}
          >
            {compact(d.rps)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { service: ServiceNode };
const edgeTypes = { flow: FlowEdge };

export interface TopologyMapProps {
  topology: TopologyResponse;
  snapshot: TopoSnapshot;
  view: IncidentView;
  selected: string | null;
  onSelect: (serviceId: string | null) => void;
}

function MapView({ topology, snapshot, view, selected, onSelect }: TopologyMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const flow = useReactFlow();
  const { scheme } = useAppearance();
  const placed = useMemo(
    () => layoutLayers(topology.services.map((s) => ({ id: s.id, layer: s.layer, dependsOn: s.dependsOn }))),
    [topology],
  );
  const svcIdx = useMemo(() => new globalThis.Map(SERVICES.map((s) => [s.id as string, s.idx])), []);

  // Fit the whole graph on every resize: the layout is fixed, so the view should always show all of it.
  const width = useRef(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      width.current = e!.contentRect.width;
      requestAnimationFrame(() => void flow.fitView({ padding: 0.12 }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [flow]);

  const incident = view.epicenter !== null;
  const roleOf = (id: string): Role =>
    !incident ? 'none' : id === view.epicenter ? 'epicenter' : view.blast.has(id) ? 'blast' : 'outside';

  const nodes: ServiceNodeT[] = placed.map((p) => {
    const def = topology.services.find((s) => s.id === p.id)!;
    const live = snapshot.services[svcIdx.get(p.id) ?? -1];
    return {
      id: p.id,
      type: 'service',
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      draggable: false,
      connectable: false,
      ariaLabel: def.name,
      data: {
        name: def.name,
        team: def.team,
        status: live?.status ?? 0,
        rps: live?.rps ?? 0,
        lat: live?.lat ?? 0,
        sloMs: def.sloMs,
        healthy: live?.healthy ?? 0,
        total: live?.total ?? 0,
        hasData: snapshot.tsSec > 0 && (live?.total ?? 0) > 0,
        role: roleOf(p.id),
        selected: selected === p.id,
      },
    };
  });

  const edgeRps = topology.edges.map((e) => (snapshot.services[svcIdx.get(e.from) ?? -1]?.rps ?? 0) * e.callFraction);
  const maxRps = Math.max(0, ...edgeRps);
  const showLabels = width.current === 0 || width.current >= 560;
  const edges: FlowEdgeT[] = topology.edges.map((e, i) => {
    const id = edgeId(e.from, e.to);
    const spread = view.spreadEdges.has(id);
    return {
      id,
      source: e.from,
      target: e.to,
      type: 'flow',
      focusable: false,
      data: {
        rps: edgeRps[i]!,
        width: edgeWidth(edgeRps[i]!, maxRps),
        spread,
        dim: incident && !spread,
        showLabel: showLabels,
      },
    };
  });

  return (
    <div ref={wrapRef} className="topology-map aspect-[4/3] max-h-[560px] min-h-[300px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={scheme}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.2}
        maxZoom={1.25}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        onNodeClick={(_e, n) => onSelect(n.id === selected ? null : n.id)}
        onPaneClick={() => onSelect(null)}
      />
    </div>
  );
}

export function TopologyMap(props: TopologyMapProps) {
  return (
    <ReactFlowProvider>
      <MapView {...props} />
    </ReactFlowProvider>
  );
}
