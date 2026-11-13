import { create } from 'zustand';
import type { IncidentDTO } from '@epicenter/shared';
import { api } from '../lib/api';

interface IncidentState {
  /** Newest first, unique by id. */
  incidents: IncidentDTO[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load: () => Promise<void>;
  apply: (incident: IncidentDTO) => void;
  reset: () => void;
}

function unwrap(res: unknown): IncidentDTO[] {
  if (Array.isArray(res)) return res as IncidentDTO[];
  const o = res as Record<string, unknown> | null;
  for (const k of ['incidents', 'items', 'data']) if (Array.isArray(o?.[k])) return o![k] as IncidentDTO[];
  return [];
}

function merge(list: IncidentDTO[], incoming: IncidentDTO[]): IncidentDTO[] {
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const i of incoming) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 200);
}

export const useIncidents = create<IncidentState>((set, get) => ({
  incidents: [],
  status: 'idle',
  error: null,

  async load() {
    if (get().status === 'idle') set({ status: 'loading' });
    try {
      const res = await api.get<unknown>('/incidents');
      set((s) => ({ incidents: merge(s.incidents, unwrap(res)), status: 'ready', error: null }));
    } catch (err) {
      set((s) => ({ status: s.incidents.length ? 'ready' : 'error', error: err instanceof Error ? err.message : 'Could not load incidents' }));
    }
  },

  apply: (incident) => set((s) => ({ incidents: merge(s.incidents, [incident]) })),
  reset: () => set({ incidents: [], status: 'idle', error: null }),
}));

export const selectOpenIncidents = (s: IncidentState): IncidentDTO[] => s.incidents.filter((i) => i.state === 'open');
