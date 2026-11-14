// Guided tour state: whether the tour is showing and which step it is on. It starts by itself the first
// time an account signs in on this browser, and is remembered per account so it does not start again.
import { create } from 'zustand';
import type { UserDTO } from '@epicenter/shared';
import { stepsFor } from '../tour/steps';

export const TOUR_STORAGE_PREFIX = 'epicenter.tour.';

export interface SavedTour {
  /** Finished or ended: do not start it again by itself. */
  done: boolean;
  /** The step to resume at. */
  step: string | null;
}

/** Null for no record or an unreadable one; both mean "this account has not seen the tour". */
export function parseSavedTour(raw: string | null): SavedTour | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<SavedTour> | null;
    if (!o || typeof o !== 'object') return null;
    return { done: o.done === true, step: typeof o.step === 'string' ? o.step : null };
  } catch {
    return null;
  }
}

/**
 * What to show when an account's session begins.
 *  - never seen: open at the first step
 *  - left part-way: a small "resume" pill at the step it was on (not the card, which would cover a page
 *    the user came back to do something else on)
 *  - finished or ended: nothing
 */
export function initialTour(saved: SavedTour | null, stepIds: readonly string[]): { status: TourStatus; stepId: string | null } {
  const first = stepIds[0] ?? null;
  if (!first || saved?.done) return { status: 'off', stepId: null };
  if (!saved) return { status: 'open', stepId: first };
  return { status: 'min', stepId: saved.step && stepIds.includes(saved.step) ? saved.step : first };
}

/** off: not showing · open: the card is showing · min: collapsed to a pill. */
export type TourStatus = 'off' | 'open' | 'min';

interface TourState {
  userId: string | null;
  status: TourStatus;
  stepId: string | null;
  /** Called when a session begins (sign-in or reload). */
  init(user: UserDTO): void;
  /** From the first step, whatever was saved. */
  restart(): void;
  setStep(stepId: string): void;
  minimize(): void;
  open(): void;
  /** Finished or ended by the user. */
  finish(): void;
}

function read(userId: string): SavedTour | null {
  try {
    return parseSavedTour(localStorage.getItem(TOUR_STORAGE_PREFIX + userId));
  } catch {
    return null; // storage blocked: the tour shows each session, which is the safe side for a newcomer
  }
}

function write(userId: string | null, saved: SavedTour): void {
  if (!userId) return;
  try {
    localStorage.setItem(TOUR_STORAGE_PREFIX + userId, JSON.stringify(saved));
  } catch {
    /* not remembered */
  }
}

export const useTour = create<TourState>((set, get) => ({
  userId: null,
  status: 'off',
  stepId: null,

  init(user) {
    if (get().userId === user.id) return;
    const ids = stepsFor(user.role).map((s) => s.id);
    const next = initialTour(read(user.id), ids);
    set({ userId: user.id, ...next });
    if (next.status === 'open') write(user.id, { done: false, step: next.stepId });
  },

  restart() {
    set({ status: 'open', stepId: null }); // TourGuide resolves null to the first step for this role
    write(get().userId, { done: false, step: null });
  },

  setStep(stepId) {
    set({ stepId, status: 'open' });
    write(get().userId, { done: false, step: stepId });
  },

  minimize: () => set((s) => (s.status === 'open' ? { status: 'min' } : s)),
  open: () => set((s) => (s.status === 'min' ? { status: 'open' } : s)),

  finish() {
    set({ status: 'off', stepId: null });
    write(get().userId, { done: true, step: null });
  },
}));
