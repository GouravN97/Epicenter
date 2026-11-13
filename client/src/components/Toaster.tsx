// Notifications for things that happen while you look elsewhere (new and resolved incidents). Announced
// politely to screen readers, dismissed after a while, and kept open while the pointer or focus is on them.
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, Info, Siren, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToasts, type Toast } from '../state/toastStore';

const TTL_MS = 8000;
const ICON = { crit: Siren, ok: CircleCheck, info: Info } as const;
const TONE = { crit: 'text-crit', ok: 'text-ok', info: 'text-accent' } as const;

function ToastItem({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [held, setHeld] = useState(false);
  const left = useRef(TTL_MS);
  useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(t.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1500, left.current - (Date.now() - started));
    };
  }, [held, dismiss, t.id]);
  const Icon = ICON[t.tone];

  return (
    <li
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className="toast-in pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line bg-raised p-3 shadow-lg shadow-black/40"
    >
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${TONE[t.tone]}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t.title}</p>
        {t.body && <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">{t.body}</p>}
        {t.to && (
          <Link to={t.to} onClick={() => dismiss(t.id)} className="mt-1.5 inline-block text-sm text-accent hover:text-accent-strong">
            {t.action ?? 'Open'}
          </Link>
        )}
      </div>
      <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded p-0.5 text-muted hover:text-fg">
        <X aria-hidden className="size-4" />
      </button>
    </li>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <ol
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-3 bottom-20 z-40 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:w-96 md:bottom-4"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </ol>
  );
}
