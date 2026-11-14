// Display mode: which of the two interfaces is shown.
//   control: the dense, always-dark control-room UI (plan §9.4)
//   glass:   roomier, with floating navigation; follows the system's light or dark appearance
// The mode is an attribute on <html> (`data-display`), so the theme tokens in index.css switch with it.
// index.html sets the attribute before the first paint; this store keeps it in sync afterwards.
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export type DisplayMode = 'control' | 'glass';
export type Scheme = 'light' | 'dark';

export const DISPLAY_MODES: readonly { id: DisplayMode; name: string; hint: string }[] = [
  { id: 'control', name: 'Control room', hint: 'Dense and always dark, for a wall display.' },
  { id: 'glass', name: 'Glass', hint: 'Roomier, with floating navigation. Light or dark with your system.' },
];

/** Also read by the inline script in index.html. */
export const DISPLAY_STORAGE_KEY = 'epicenter.display';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const CONTRAST_QUERY = '(prefers-contrast: more)';

export function parseDisplayMode(raw: unknown): DisplayMode {
  return raw === 'glass' ? 'glass' : 'control';
}

/** The control room is dark whatever the system says; Glass follows the system. */
export function resolveScheme(mode: DisplayMode, systemDark: boolean): Scheme {
  return mode === 'control' || systemDark ? 'dark' : 'light';
}

const hasDom = typeof document !== 'undefined';

function readStored(): DisplayMode {
  if (!hasDom) return 'control';
  try {
    return parseDisplayMode(localStorage.getItem(DISPLAY_STORAGE_KEY));
  } catch {
    return 'control'; // storage blocked: the mode still works, it just is not remembered
  }
}

/** Writes the mode to <html> and keeps the browser chrome (address bar, form controls) in step. */
function applyToDocument(mode: DisplayMode): void {
  if (!hasDom) return;
  const root = document.documentElement;
  root.dataset.display = mode;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', mode === 'glass' ? 'light dark' : 'dark');
  const bg = getComputedStyle(root).getPropertyValue('--color-bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

interface DisplayState {
  mode: DisplayMode;
  setMode(mode: DisplayMode): void;
}

export const useDisplay = create<DisplayState>((set) => ({
  mode: readStored(),
  setMode: (mode) => {
    // The attribute changes before React re-renders, so effects that read the tokens see the new values.
    applyToDocument(mode);
    try {
      localStorage.setItem(DISPLAY_STORAGE_KEY, mode);
    } catch {
      /* not remembered */
    }
    set({ mode });
  },
}));

if (hasDom) {
  applyToDocument(useDisplay.getState().mode);
  // In Glass the page colour follows the system appearance, and the address-bar colour with it.
  window.matchMedia(DARK_QUERY).addEventListener('change', () => applyToDocument(useDisplay.getState().mode));
}

function subscribeSystem(onChange: () => void): () => void {
  const queries = [window.matchMedia(DARK_QUERY), window.matchMedia(CONTRAST_QUERY)];
  for (const q of queries) q.addEventListener('change', onChange);
  return () => {
    for (const q of queries) q.removeEventListener('change', onChange);
  };
}
const systemSnapshot = (): string => `${window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'}${window.matchMedia(CONTRAST_QUERY).matches ? '+contrast' : ''}`;

export interface Appearance {
  mode: DisplayMode;
  scheme: Scheme;
  /**
   * Changes whenever the resolved token values can change (mode, system appearance, contrast setting).
   * Canvas components put it in their effect dependencies, because they read the tokens once with
   * getComputedStyle and would otherwise keep drawing in the old colours.
   */
  key: string;
}

export function useAppearance(): Appearance {
  const mode = useDisplay((s) => s.mode);
  const system = useSyncExternalStore(subscribeSystem, systemSnapshot, () => 'dark');
  const scheme = resolveScheme(mode, system.startsWith('dark'));
  return { mode, scheme, key: mode === 'control' ? 'control' : `glass:${system}` };
}
