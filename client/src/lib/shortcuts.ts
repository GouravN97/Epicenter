// Keyboard shortcuts: the list shown in the help dialog (press ?) and the pure logic that decides what a
// key press means. components/Shortcuts.tsx listens for keys and acts on them.
//
// A control on a page gets its key by spreading `hotkey('c')` into its element. The listener finds the
// visible, enabled control carrying the pressed key and clicks it, so a shortcut always does exactly what
// the button does and needs no wiring into the page's state.
import type { Role } from '@epicenter/shared';

export interface Shortcut {
  /** Keys as shown, e.g. "g o" (g, then o) or "1 – 4". */
  keys: string;
  label: string;
  roles?: Role[];
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

/** Second key of the "g then …" navigation sequences, by route. */
export const NAV_KEYS: Readonly<Record<string, string>> = {
  '/': 'o',
  '/topology': 't',
  '/incidents': 'i',
  '/chaos': 'c',
  '/pipeline': 'p',
};

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Anywhere',
    items: [
      { keys: '?', label: 'Show or hide this list' },
      { keys: 'g o', label: 'Go to Overview' },
      { keys: 'g t', label: 'Go to Topology' },
      { keys: 'g i', label: 'Go to Incidents' },
      { keys: 'g c', label: 'Go to Chaos Lab', roles: ['admin'] },
      { keys: 'g p', label: 'Go to Pipeline' },
      { keys: 'd', label: 'Switch display mode (Control room / Glass)' },
      { keys: 't', label: 'Start, hide or resume the guided tour' },
    ],
  },
  {
    title: 'Guided tour',
    items: [
      { keys: 'n', label: 'Next step (or skip the exercise)' },
      { keys: 'b', label: 'Previous step' },
    ],
  },
  {
    title: 'Overview',
    items: [
      { keys: 'f', label: 'Focus the fleet heatmap (then arrow keys, Enter to open a node)' },
      { keys: 'a', label: 'Switch the alert feed between Active and All' },
      { keys: 'i', label: 'Open the incident in the banner' },
      { keys: 'e', label: 'Export the alerts shown as a .json file' },
    ],
  },
  {
    title: 'Node page',
    items: [
      { keys: '1 – 4', label: 'Time range: 5 m, 15 m, 1 h, 6 h' },
      { keys: 'c', label: 'Compare with 1 h ago' },
      { keys: 'e', label: 'Export the selected metrics as a .json file' },
    ],
  },
  {
    title: 'Incidents',
    items: [
      { keys: 'a', label: 'Switch the list between Open and All' },
      { keys: 'p', label: 'In an incident: replay, play or pause' },
      { keys: 's', label: 'In an incident: back to the start of the recording' },
      { keys: '1 – 3', label: 'In an incident: playback speed 1×, 4×, 16×' },
      { keys: 'l', label: 'In an incident: go live' },
    ],
  },
];

export const shortcutsFor = (role: Role): ShortcutGroup[] =>
  SHORTCUT_GROUPS.map((g) => ({ ...g, items: g.items.filter((s) => !s.roles || s.roles.includes(role)) })).filter((g) => g.items.length > 0);

/** Props that give a control its shortcut key. `focus` moves focus to it instead of clicking it. */
export function hotkey(key: string, action: 'click' | 'focus' = 'click'): { 'data-hotkey': string; 'data-hotkey-action'?: 'focus'; 'aria-keyshortcuts': string } {
  return { 'data-hotkey': key, 'aria-keyshortcuts': key, ...(action === 'focus' ? { 'data-hotkey-action': 'focus' as const } : {}) };
}

interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** The shortcut key a press stands for, or null if it is not one (a modifier combination, a named key). */
export function shortcutKey(e: KeyLike): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null; // browser and system shortcuts are left alone
  return e.key.length === 1 && e.key !== ' ' ? e.key.toLowerCase() : null;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** True when the user is typing into something, so letters must reach it. */
export function isTyping(target: TargetLike | null): boolean {
  if (!target?.tagName) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (target.getAttribute?.('type') ?? 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(type);
}

export type KeyAction = { kind: 'help' } | { kind: 'prefix' } | { kind: 'nav'; to: string } | { kind: 'display' } | { kind: 'control'; key: string } | { kind: 'none' };

/**
 * What a key means. `afterG` is true when the previous key was `g` (pressed a moment ago), which turns
 * this key into the second half of a navigation sequence. `routes` are the pages this user may open.
 */
export function resolveKey(key: string, afterG: boolean, routes: readonly string[]): KeyAction {
  if (afterG) {
    const to = routes.find((r) => NAV_KEYS[r] === key);
    return to ? { kind: 'nav', to } : { kind: 'none' };
  }
  if (key === '?') return { kind: 'help' };
  if (key === 'g') return { kind: 'prefix' };
  if (key === 'd') return { kind: 'display' };
  return { kind: 'control', key };
}

interface ControlLike {
  getAttribute(name: string): string | null;
}

/**
 * Of the controls on screen carrying a key, the one to act on: the first that is not already selected.
 * That makes one key toggle a pair of tabs (Active / All) and leaves a pressed radio button alone.
 */
export function pickControl<T extends ControlLike>(controls: readonly T[]): T | null {
  const on = (c: T) => c.getAttribute('aria-selected') === 'true' || c.getAttribute('aria-checked') === 'true';
  return controls.find((c) => !on(c)) ?? null;
}
