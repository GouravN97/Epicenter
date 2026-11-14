// Chaos Lab state. Runs are low-frequency control data, so ordinary UI state is right here.
import { create } from 'zustand';
import { CHAOS_SCENARIOS, type ChaosActiveRun, type ChaosScenarioDef, type ChaosScorecard, type ChaosStartBody, type ChaosUpd } from '@epicenter/shared';
import { api, HttpError } from '../lib/api';

/** A run in the history table: its scorecard plus what the server adds about the run, when it does. */
export interface RunRow extends ChaosScorecard {
  endsAt?: number;
  endedAt?: number | null;
  startedBy?: string;
  incidentId?: string | null;
}

interface ChaosState {
  scenarios: readonly ChaosScenarioDef[];
  active: ChaosActiveRun[];
  history: RunRow[];
  /** False when the server has no GET /chaos/runs: history is then the runs started from this tab. */
  serverHistory: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load(): Promise<void>;
  loadHistory(): Promise<void>;
  applyUpdate(upd: ChaosUpd): void;
  start(body: ChaosStartBody): Promise<ChaosActiveRun>;
  stop(runId?: string): Promise<void>;
}

/** GET /chaos/scenarios may return the list itself or `{ scenarios, active }`. */
function unwrapScenarios(res: unknown): { scenarios: ChaosScenarioDef[] | null; active: ChaosActiveRun[] | null } {
  if (Array.isArray(res)) return { scenarios: res as ChaosScenarioDef[], active: null };
  const o = res as { scenarios?: unknown; active?: unknown } | null;
  return {
    scenarios: Array.isArray(o?.scenarios) ? (o!.scenarios as ChaosScenarioDef[]) : null,
    active: Array.isArray(o?.active) ? (o!.active as ChaosActiveRun[]) : null,
  };
}

/** Server scenario entries may be partial; fill gaps from the shared definitions. */
function mergeScenarios(fromServer: ChaosScenarioDef[] | null): readonly ChaosScenarioDef[] {
  if (!fromServer?.length) return CHAOS_SCENARIOS;
  return fromServer.map((s) => ({ ...(CHAOS_SCENARIOS.find((d) => d.id === s.id) ?? {}), ...s }) as ChaosScenarioDef);
}

export const useChaos = create<ChaosState>((set, get) => ({
  scenarios: CHAOS_SCENARIOS,
  active: [],
  history: [],
  serverHistory: true,
  status: 'idle',
  error: null,

  async load() {
    if (get().status === 'idle') set({ status: 'loading' });
    try {
      const { scenarios, active } = unwrapScenarios(await api.get<unknown>('/chaos/scenarios'));
      set({ scenarios: mergeScenarios(scenarios), ...(active ? { active } : {}), status: 'ready', error: null });
    } catch (err) {
      // The cards can still be shown from the shared definitions; starting a run reports its own error.
      set({ status: 'error', error: err instanceof Error ? err.message : 'Could not load scenarios' });
    }
  },

  async loadHistory() {
    if (!get().serverHistory) return;
    try {
      const rows = await api.get<unknown>('/chaos/runs');
      const list = Array.isArray(rows) ? rows : ((rows as { runs?: unknown })?.runs ?? []);
      set({ history: (list as RunRow[]).slice(0, 50) });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) set({ serverHistory: false });
    }
  },

  applyUpdate: (upd) => set({ active: Array.isArray(upd?.active) ? upd.active : [] }),

  async start(body) {
    const run = await api.post<ChaosActiveRun>('/chaos/start', body);
    const startedAt = Date.now();
    set((s) => ({
      // chaos:upd normally arrives too; adding it here makes the card respond at once either way.
      active: run?.runId && !s.active.some((a) => a.runId === run.runId) ? [...s.active, run] : s.active,
      history: s.serverHistory
        ? s.history
        : [
            {
              runId: run?.runId ?? `local-${startedAt}`,
              scenario: body.scenario,
              target: body.target ?? run?.target ?? null,
              startedAt,
              detectedAt: null,
              timeToDetectMs: null,
              detectedEpicenter: null,
              correct: null,
              endsAt: run?.endsAt,
            },
            ...s.history,
          ].slice(0, 50),
    }));
    void get().loadHistory();
    return run;
  },

  async stop(runId) {
    const upd = await api.post<ChaosUpd | undefined>('/chaos/stop', runId ? { runId } : {});
    if (upd && Array.isArray(upd.active)) get().applyUpdate(upd);
    else set((s) => ({ active: runId ? s.active.filter((a) => a.runId !== runId) : [] }));
    void get().loadHistory();
  },
}));
