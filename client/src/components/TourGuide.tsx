// The guided tour's interface: a card docked in a corner that explains the current step, a ring around
// the part of the page it is about, and a pill to resume when the card is hidden. The page stays fully
// usable underneath, because most steps ask the user to do something in the real app.
// Step content and logic live in tour/steps.ts; which step is showing lives in state/tourStore.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Circle, CircleCheck, GraduationCap, Minus, TriangleAlert, Unplug, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { clock, topology } from '../data/live';
import { USE_MOCK } from '../lib/env';
import { hotkey } from '../lib/shortcuts';
import { dropConnection } from '../lib/socket';
import { useAlerts } from '../state/alertStore';
import { useAuth } from '../state/authStore';
import { useChaos } from '../state/chaosStore';
import { useIncidents } from '../state/incidentStore';
import { useTour } from '../state/tourStore';
import { isAt, routeOf, stepsFor, type TourCtx, type TourStep } from '../tour/steps';

const DROP_MS = 10_000;
/** How long a finished exercise shows "Done" before the tour moves on. */
const ADVANCE_MS = 1600;
const TICK_MS = 400;

/** Everything a step may look at, read from the stores and the page at this moment. */
function readCtx(pathname: string, role: TourCtx['role']): TourCtx {
  const chaos = useChaos.getState();
  return {
    pathname,
    role,
    mock: USE_MOCK,
    firstNodeId: topology.getSnapshot()?.nodes[0]?.[1] ?? null,
    alerts: useAlerts.getState().alerts,
    incidents: useIncidents.getState().incidents,
    chaosActive: chaos.active,
    chaosHistory: chaos.history,
    replaying: clock.mode === 'replay',
    comparing: document.querySelector('[data-tour="node-compare"]')?.getAttribute('aria-pressed') === 'true',
  };
}

/** `**text**` becomes emphasis; everything else is plain text. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((part, i) =>
        i % 2 ? (
          <strong key={i} className="font-semibold text-fg">
            {part}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The target's box on screen, clipped to the viewport, or null when it is missing or scrolled away. */
function boxOf(el: Element | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const pad = 6;
  const top = Math.max(4, r.top - pad);
  const left = Math.max(4, r.left - pad);
  const bottom = Math.min(window.innerHeight - 4, r.bottom + pad);
  const right = Math.min(window.innerWidth - 4, r.right + pad);
  if (bottom - top < 24 || right - left < 24) return null;
  return { top, left, width: right - left, height: bottom - top };
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1);

export function TourGuide() {
  const user = useAuth((s) => s.user);
  const { status, stepId, init, setStep, minimize, open, finish } = useTour();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) init(user);
  }, [user, init]);

  const role = user?.role ?? 'viewer';
  const steps = useMemo(() => stepsFor(role), [role]);
  const index = Math.max(0, steps.findIndex((s) => s.id === stepId));
  const step: TourStep | undefined = steps[index];

  const [ctx, setCtx] = useState<TourCtx>(() => readCtx(pathname, role));
  const [box, setBox] = useState<Box | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);

  /** Go to a step, and to the page it happens on. */
  const go = useCallback(
    (i: number) => {
      const next = steps[Math.min(Math.max(i, 0), steps.length - 1)];
      if (!next) return;
      setStep(next.id);
      const now = readCtx(window.location.pathname, role);
      const to = routeOf(next, now);
      if (to && !isAt(next, now)) navigate(to);
    },
    [steps, role, setStep, navigate],
  );

  // While the card is open: keep the context fresh (exercises complete by themselves), keep the ring on
  // its target as the page scrolls and lays out, and bring the target into view once per step.
  useEffect(() => {
    if (status !== 'open' || !step) {
      setBox(null);
      return;
    }
    const tick = () => {
      const now = readCtx(pathname, role);
      setCtx(now);
      const el = step.target && isAt(step, now) ? document.querySelector(`[data-tour="${step.target}"]`) : null;
      if (el && scrolledFor.current !== step.id) {
        scrolledFor.current = step.id;
        const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // On a phone the card covers the lower half of the screen, so the target goes to the top instead.
        el.scrollIntoView({ block: window.innerWidth < 768 ? 'start' : 'center', behavior: calm ? 'auto' : 'smooth' });
      }
      const next = boxOf(el);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    const onMove = () => {
      const el = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
      const next = boxOf(el);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      clearInterval(timer);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [status, step, pathname, role]);

  // An exercise that completes while its step is showing moves the tour on. One that was already complete
  // when the step opened (the user came Back) does not, or the step could never be read.
  const taskDone = !!step?.task?.done(ctx);
  const armed = useRef<{ id: string; pending: boolean } | null>(null);
  useEffect(() => {
    if (status !== 'open' || !step?.task) return;
    if (armed.current?.id !== step.id) armed.current = { id: step.id, pending: !step.task.done(readCtx(window.location.pathname, role)) };
    if (!taskDone || !armed.current.pending) return;
    const t = setTimeout(() => {
      armed.current = null;
      go(index + 1);
    }, ADVANCE_MS);
    return () => clearTimeout(t);
  }, [status, step, taskDone, index, go, role]);

  // Notifications sit in the same corner: tell the stylesheet how much room the tour takes.
  useEffect(() => {
    const root = document.documentElement;
    if (status === 'off') return;
    const measure = () => {
      const el = dock.current?.firstElementChild;
      if (el) root.style.setProperty('--tour-gap', `${Math.round(window.innerHeight - el.getBoundingClientRect().top)}px`);
    };
    root.dataset.tourOn = '';
    measure();
    const ro = new ResizeObserver(measure);
    if (dock.current?.firstElementChild) ro.observe(dock.current.firstElementChild);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      delete root.dataset.tourOn;
      root.style.removeProperty('--tour-gap');
    };
  }, [status, step?.id]);

  const [dropped, setDropped] = useState(false);
  useEffect(() => setDropped(false), [step?.id]);

  if (!user || status === 'off' || !step) return null;

  if (status === 'min') {
    return (
      <div ref={dock} className="tour-dock">
        <button
          type="button"
          onClick={() => {
            open();
            go(index);
          }}
          {...hotkey('t')}
          className="popover inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium text-fg transition-colors hover:text-accent-strong"
        >
          <GraduationCap aria-hidden className="size-4 text-accent" />
          Resume tour
          <span className="metric text-xs text-muted">
            {index + 1}/{steps.length}
          </span>
        </button>
      </div>
    );
  }

  const here = isAt(step, ctx);
  const to = routeOf(step, ctx);
  const last = index === steps.length - 1;
  const caution = here ? (step.caution?.(ctx) ?? null) : null;

  return (
    <>
      {box && <div aria-hidden className="tour-ring" style={box} />}
      <div ref={dock} className="tour-dock" data-side={step.side}>
        <section aria-label="Guided tour" className="tour-card popover rounded-xl">
          <header className="flex shrink-0 items-center gap-2 px-4 pt-3">
            <GraduationCap aria-hidden className="size-4 shrink-0 text-accent" />
            <p className="min-w-0 flex-1 truncate text-xs text-muted">
              <span className="font-medium text-accent">{step.chapter}</span> · Step {index + 1} of {steps.length}
            </p>
            <button type="button" onClick={minimize} {...hotkey('t')} className="rounded p-1 text-muted hover:text-fg" aria-label="Hide the tour" title="Hide (resume any time: T)">
              <Minus aria-hidden className="size-4" />
            </button>
            <button type="button" onClick={finish} className="rounded p-1 text-muted hover:text-fg" aria-label="End the tour" title="End the tour">
              <X aria-hidden className="size-4" />
            </button>
          </header>
          <div className="mx-4 mt-2 h-1 shrink-0 overflow-hidden rounded-full bg-fill-strong" aria-hidden>
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
            <h2 className="text-base font-semibold tracking-tight">{step.title}</h2>
            {step.body.map((p) => (
              <p key={p} className="mt-2 text-sm leading-relaxed text-muted">
                <Rich text={p} />
              </p>
            ))}
            {step.points && (
              <dl className="mt-3 space-y-1.5 text-sm">
                {step.points.map(([term, meaning]) => (
                  <div key={term} className="flex gap-2">
                    <dt className="w-24 shrink-0 font-medium text-fg">{term}</dt>
                    <dd className="min-w-0 text-muted">{meaning}</dd>
                  </div>
                ))}
              </dl>
            )}
            {step.quiz && (
              <div className="mt-3 space-y-1.5">
                {step.quiz.map(({ q, a }) => (
                  <details key={q} className="rounded-md border border-line px-3 py-2 text-sm">
                    <summary className="cursor-pointer font-medium text-fg">{q}</summary>
                    <p className="mt-1.5 leading-relaxed text-muted">{a}</p>
                  </details>
                ))}
              </div>
            )}

            {!here && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line px-3 py-2 text-sm">
                <p className="min-w-0 flex-1 text-muted">This step is on {step.place ?? 'another page'}.</p>
                {to ? (
                  <button type="button" className="btn text-accent" onClick={() => navigate(to)}>
                    Take me there
                  </button>
                ) : (
                  <span className="text-muted">Loading…</span>
                )}
              </div>
            )}

            {step.task && here && (
              <div className={`mt-3 flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${taskDone ? 'border-ok/50' : 'border-accent/50 bg-accent-soft'}`}>
                {taskDone ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />}
                <p className="min-w-0 text-fg">
                  <span className="font-semibold">{taskDone ? 'Done. ' : 'Your turn. '}</span>
                  {step.task.label}
                </p>
              </div>
            )}
            {caution && (
              <p className="mt-2 flex items-start gap-2 text-sm text-warn">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {caution}
              </p>
            )}
            {step.action === 'drop' && here && (
              <button
                type="button"
                className="btn mt-3 text-accent"
                disabled={dropped}
                onClick={() => {
                  dropConnection(DROP_MS);
                  setDropped(true);
                  setTimeout(() => setDropped(false), DROP_MS + 2000);
                }}
              >
                <Unplug aria-hidden className="size-4" />
                {dropped ? 'Dropped. Watch the badge and the charts' : `Drop the connection for ${DROP_MS / 1000} s`}
              </button>
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <button type="button" className="btn text-muted" onClick={() => go(index - 1)} disabled={index === 0} {...hotkey('b')}>
              <ArrowLeft aria-hidden className="size-4" />
              Back
            </button>
            {last ? (
              <button type="button" className="btn-primary" onClick={finish} {...hotkey('n')}>
                Finish
              </button>
            ) : (
              <button type="button" className="btn-primary gap-1.5" onClick={() => go(index + 1)} {...hotkey('n')}>
                {index === 0 ? 'Start' : step.task && here && !taskDone ? 'Skip' : 'Next'}
                <ArrowRight aria-hidden className="size-4" />
              </button>
            )}
          </footer>
        </section>
      </div>
    </>
  );
}

/** Toolbar button: starts the tour, or brings it back if it is hidden. */
export function TourButton({ className, showLabel = true }: { className: string; showLabel?: boolean }) {
  const status = useTour((s) => s.status);
  const restart = useTour((s) => s.restart);
  const open = useTour((s) => s.open);
  return (
    <button type="button" className={className} onClick={() => (status === 'off' ? restart() : open())} aria-pressed={status === 'open'} {...(status === 'off' ? hotkey('t') : {})}>
      <GraduationCap aria-hidden className="size-4" />
      <span className={showLabel ? 'hidden sm:inline' : 'sr-only'}>Tour</span>
      {showLabel && <span className="sr-only sm:hidden">Tour</span>}
    </button>
  );
}
