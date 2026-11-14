import { create } from 'zustand';
import type { IncidentDTO } from '@epicenter/shared';
import { SERVICE_BY_ID, isServiceId } from '@epicenter/shared';
import { api, HttpError } from '../lib/api';
import { useToasts } from './toastStore';

/** How long a new incident is left to settle before it is announced. */
const NEW_INCIDENT_SETTLE_MS = 3000;

interface IncidentState {
  /** Newest first, unique by id. */
  incidents: IncidentDTO[];
  /** `unavailable`: the server has no such endpoint yet (404); not an error the user can fix. */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  error: string | null;
  load: () => Promise<void>;
  /** Merges a live incident event, notifying on new and resolved incidents. */
  apply: (incident: IncidentDTO, event?: 'new' | 'upd') => void;
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
      if (err instanceof HttpError && err.status === 404) return set({ status: 'unavailable', error: null });
      set((s) => ({ status: s.incidents.length ? 'ready' : 'error', error: err instanceof Error ? err.message : 'Could not load incidents' }));
    }
  },

  apply(incident, event) {
    const prev = get().incidents.find((i) => i.id === incident.id);
    set((s) => ({ incidents: merge(s.incidents, [incident]) }));
    // Live events only (loads merge silently), and only for changes worth interrupting for.
    const name = (id: string | null) => (id && isServiceId(id) ? SERVICE_BY_ID[id].name : id);
    // Only incident:new announces a new incident: an update for one the list has not loaded yet is not news.
    if (!prev && event === 'new' && incident.state === 'open') {
      // Wait a moment: the first alerts of a cascade arrive within seconds of each other and the epicenter
      // is often revised while they do. Announce the settled picture rather than the first guess.
      setTimeout(() => {
        const cur = get().incidents.find((i) => i.id === incident.id);
        if (!cur || cur.state !== 'open') return;
        useToasts.getState().push({
          tone: 'crit',
          title: 'New incident',
          body: cur.epicenter ? `Epicenter ${name(cur.epicenter)} · ${cur.title}` : cur.title || 'Alerts are being correlated',
          to: `/incidents/${cur.id}`,
          action: 'Open incident room',
        });
      }, NEW_INCIDENT_SETTLE_MS);
    } else if (prev?.state === 'open' && incident.state === 'resolved') {
      useToasts.getState().push({
        tone: 'ok',
        title: 'Incident resolved',
        body: incident.title,
        to: `/incidents/${incident.id}`,
        action: 'Replay it',
      });
    }
  },
  reset: () => set({ incidents: [], status: 'idle', error: null }),
}));

export const selectOpenIncidents = (s: IncidentState): IncidentDTO[] => s.incidents.filter((i) => i.state === 'open');
