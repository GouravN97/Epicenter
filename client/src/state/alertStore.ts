// Alerts are low-frequency lifecycle events, so they live in ordinary UI state (unlike telemetry).
import { create } from 'zustand';
import type { AlertDTO } from '@epicenter/shared';
import { api } from '../lib/api';

const MAX_ALERTS = 500;

interface AlertState {
  /** Newest first, unique by id. */
  alerts: AlertDTO[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Ids that arrived live in the last moments, for the brief highlight. */
  fresh: ReadonlySet<string>;
  load: () => Promise<void>;
  apply: (alert: AlertDTO, live?: boolean) => void;
  ack: (id: string) => Promise<void>;
  reset: () => void;
}

/** GET /alerts may answer with a bare array or wrap it; accept either. */
function unwrap(res: unknown): AlertDTO[] {
  if (Array.isArray(res)) return res as AlertDTO[];
  const o = res as Record<string, unknown> | null;
  for (const k of ['alerts', 'items', 'data']) if (Array.isArray(o?.[k])) return o![k] as AlertDTO[];
  return [];
}

function merge(list: AlertDTO[], incoming: AlertDTO[]): AlertDTO[] {
  const byId = new Map(list.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1)).slice(0, MAX_ALERTS);
}

export const useAlerts = create<AlertState>((set, get) => ({
  alerts: [],
  status: 'idle',
  error: null,
  fresh: new Set(),

  async load() {
    if (get().status === 'idle') set({ status: 'loading' });
    try {
      const res = await api.get<unknown>('/alerts', { limit: 200 });
      // Merge, not replace: live events may have arrived while the request was in flight.
      set((s) => ({ alerts: merge(s.alerts, unwrap(res)), status: 'ready', error: null }));
    } catch (err) {
      set((s) => ({ status: s.alerts.length ? 'ready' : 'error', error: err instanceof Error ? err.message : 'Could not load alerts' }));
    }
  },

  apply(alert, live = false) {
    const isNew = live && !get().alerts.some((a) => a.id === alert.id);
    set((s) => ({ alerts: merge(s.alerts, [alert]), fresh: isNew ? new Set(s.fresh).add(alert.id) : s.fresh }));
    if (isNew) {
      setTimeout(() => {
        set((s) => {
          const fresh = new Set(s.fresh);
          fresh.delete(alert.id);
          return { fresh };
        });
      }, 2500);
    }
  },

  async ack(id) {
    const updated = await api.post<AlertDTO>(`/alerts/${encodeURIComponent(id)}/ack`);
    if (updated && typeof updated === 'object' && 'id' in updated) get().apply(updated);
  },

  reset: () => set({ alerts: [], status: 'idle', error: null, fresh: new Set() }),
}));
