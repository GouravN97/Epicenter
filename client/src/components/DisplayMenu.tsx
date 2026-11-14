// Display-mode picker: a button in the shell's toolbar that opens a small menu of the modes, each with a
// thumbnail, its name and one line on what it is for. Choosing a mode swaps the whole shell, so the
// button that opened the menu is replaced by its counterpart in the other shell; focus is handed to it.
import { useEffect, useRef, useState } from 'react';
import { Check, MonitorCog } from 'lucide-react';
import { DISPLAY_MODES, useDisplay, type DisplayMode } from '../state/displayStore';

/** Set when a mode is chosen; the picker that mounts in the new shell takes focus and clears it. */
let focusAfterSwitch = false;

/**
 * Thumbnail of a mode. The colours are fixed on purpose: each thumbnail shows its own mode, whichever
 * mode is on screen. Glass is drawn half light, half dark, because it follows the system appearance.
 */
function ModePreview({ id }: { id: DisplayMode }) {
  if (id === 'control') {
    return (
      <svg viewBox="0 0 48 34" className="h-[34px] w-12 shrink-0 rounded-[5px]" aria-hidden>
        <rect width="48" height="34" fill="#0b0e13" />
        <rect width="12" height="34" fill="#11151c" />
        <path d="M12.5 0v34M12 7.5h36" stroke="#252c39" />
        <rect x="2.5" y="10" width="7" height="2" rx="1" fill="#6ea8fe" />
        <rect x="2.5" y="15" width="7" height="2" rx="1" fill="#5d6678" />
        <rect x="2.5" y="20" width="7" height="2" rx="1" fill="#5d6678" />
        <rect x="16.5" y="11.5" width="12" height="8" rx="1.5" fill="#11151c" stroke="#252c39" />
        <rect x="31.5" y="11.5" width="12" height="8" rx="1.5" fill="#11151c" stroke="#252c39" />
        <rect x="16.5" y="22.5" width="27" height="8" rx="1.5" fill="#11151c" stroke="#252c39" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 48 34" className="h-[34px] w-12 shrink-0 rounded-[5px]" aria-hidden>
      <rect width="48" height="34" fill="#f1f2f6" />
      <path d="M48 0v34H14z" fill="#060709" />
      <rect x="2.5" y="2.5" width="11" height="29" rx="3.5" fill="#ffffff" fillOpacity="0.85" stroke="#12151b" strokeOpacity="0.12" />
      <rect x="4.5" y="8" width="7" height="2" rx="1" fill="#1859c6" />
      <rect x="4.5" y="13" width="7" height="2" rx="1" fill="#12151b" fillOpacity="0.35" />
      <rect x="4.5" y="18" width="7" height="2" rx="1" fill="#12151b" fillOpacity="0.35" />
      <rect x="17" y="9" width="12" height="9" rx="3" fill="#ffffff" />
      <rect x="32" y="9" width="12" height="9" rx="3" fill="#20232a" />
      <rect x="17" y="21" width="27" height="9" rx="3" fill="#ffffff" />
      <path d="M44 21v6a3 3 0 0 1-3 3H27.6l6.1-9z" fill="#20232a" />
    </svg>
  );
}

export function DisplayMenu({ buttonClassName, showLabel = true }: { buttonClassName: string; showLabel?: boolean }) {
  const mode = useDisplay((s) => s.mode);
  const setMode = useDisplay((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusAfterSwitch) return;
    focusAfterSwitch = false;
    button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  function choose(next: DisplayMode) {
    if (next === mode) {
      close(true);
      return;
    }
    focusAfterSwitch = true;
    setOpen(false);
    setMode(next);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') setOpen(false);
  }

  return (
    <div ref={wrap} className="relative">
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={buttonClassName}>
        <MonitorCog aria-hidden className="size-4" />
        <span className={showLabel ? 'hidden sm:inline' : 'sr-only'}>Display</span>
        {showLabel && <span className="sr-only sm:hidden">Display</span>}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Display mode"
          onKeyDown={onMenuKey}
          className="popover absolute right-0 top-full z-50 mt-2 w-[min(19rem,calc(100vw-1.5rem))] rounded-lg p-1.5"
        >
          {DISPLAY_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m.id}
              onClick={() => choose(m.id)}
              className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors hover:bg-fill"
            >
              <ModePreview id={m.id} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-fg">{m.name}</span>
                <span className="block text-xs text-muted">{m.hint}</span>
              </span>
              <Check aria-hidden className={`size-4 shrink-0 text-accent ${mode === m.id ? '' : 'invisible'}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
