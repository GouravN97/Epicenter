// Keyboard shortcuts: one key listener for the whole app, and the help dialog that lists the keys
// (press ?). The keys and what they mean are defined in lib/shortcuts.ts.
import { useEffect, useRef, useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { isTyping, pickControl, resolveKey, shortcutKey, shortcutsFor } from '../lib/shortcuts';
import { useAuth } from '../state/authStore';
import { useDisplay } from '../state/displayStore';
import { navFor } from './shell/shared';

/** How long after `g` the next key still counts as the second half of the sequence. */
const SEQUENCE_MS = 1200;
const OPEN_EVENT = 'epicenter:shortcuts';

const visible = (el: HTMLElement) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';

/** Acts on the on-screen control that carries this key. Returns whether there was one. */
function pressControl(key: string): boolean {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-hotkey="${CSS.escape(key)}"]`)].filter(visible);
  const el = pickControl(all);
  if (!el) return false;
  if (el.dataset.hotkeyAction === 'focus') el.focus();
  else el.click();
  return true;
}

function Keys({ keys }: { keys: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.split(' ').map((k, i) =>
        k === '–' ? (
          <span key={i} className="text-faint">
            –
          </span>
        ) : (
          <kbd key={i} className="metric min-w-6 rounded border border-line bg-surface px-1.5 py-0.5 text-center text-xs text-fg">
            {k}
          </kbd>
        ),
      )}
    </span>
  );
}

export function Shortcuts() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const routes = navFor(user).map((n) => n.to);
  // The listener is attached once; it reads what changes through a ref.
  const live = useRef({ routes, navigate });
  live.current = { routes, navigate };

  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isTyping(e.target as HTMLElement | null)) return;
      const key = shortcutKey(e);
      if (!key) return;
      const helpOpen = !!dialog.current?.open;
      const afterG = !helpOpen && performance.now() - gAt < SEQUENCE_MS;
      gAt = 0;
      const action = resolveKey(key, afterG, live.current.routes);
      // While the list is open it is the only thing on screen to act on: ? closes it, other keys wait.
      if (helpOpen && action.kind !== 'help') return;
      switch (action.kind) {
        case 'help':
          setOpen((o) => !o);
          break;
        case 'prefix':
          gAt = performance.now();
          return; // not handled yet: the next key decides
        case 'nav':
          live.current.navigate(action.to);
          break;
        case 'display': {
          const { mode, setMode } = useDisplay.getState();
          setMode(mode === 'glass' ? 'control' : 'glass');
          break;
        }
        case 'control':
          if (!pressControl(action.key)) return;
          break;
        case 'none':
          return;
      }
      e.preventDefault();
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // <dialog> gives the focus trap, Escape to close and focus return for free.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const groups = shortcutsFor(user?.role ?? 'viewer');

  return (
    <dialog
      ref={dialog}
      onClose={() => setOpen(false)}
      onClick={(e) => e.target === dialog.current && setOpen(false)}
      aria-labelledby="shortcuts-title"
      className="shortcuts-dialog popover m-auto w-[min(44rem,calc(100vw-1.5rem))] rounded-xl p-0 text-fg"
    >
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <Keyboard aria-hidden className="size-4 text-accent" />
        <h2 id="shortcuts-title" className="flex-1 text-base font-semibold tracking-tight">
          Keyboard shortcuts
        </h2>
        <button type="button" onClick={() => setOpen(false)} className="rounded p-1 text-muted hover:text-fg" aria-label="Close">
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="grid max-h-[70vh] gap-x-8 gap-y-5 overflow-y-auto px-5 py-4 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="mb-2 text-xs font-medium text-accent">{g.title}</h3>
            <ul className="space-y-2">
              {g.items.map((s) => (
                <li key={s.keys} className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0 text-muted">{s.label}</span>
                  <Keys keys={s.keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="border-t border-line px-5 py-2.5 text-xs text-muted">
        Shortcuts are single keys and pause while you type in a field. Starting and stopping faults, acknowledging alerts and signing out have no shortcut, on
        purpose.
      </p>
    </dialog>
  );
}

/** Toolbar button that opens the list. Hidden on phones, which have no keyboard. */
export function ShortcutsButton({ className }: { className: string }) {
  return (
    <button type="button" className={`${className} max-md:!hidden`} onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} aria-keyshortcuts="?" title="Keyboard shortcuts (?)">
      <Keyboard aria-hidden className="size-4" />
      <span className="sr-only">Keyboard shortcuts</span>
    </button>
  );
}
