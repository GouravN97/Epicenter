// Shell of the Glass display mode. Two layers:
//   content     the page, scrolling the full height of the window on a grouped background
//   functional  navigation floating above it on a translucent material: a sidebar on wide windows, a
//               tab bar on narrow ones, and a toolbar group for status, display mode and sign-out
// The layout is keyed to the width available (md breakpoint), not to the device. Both layouts reach the
// same pages; the toolbar offers the same controls in each.
import { LogOut, PanelLeft } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../state/authStore';
import { selectOpenIncidents, useIncidents } from '../../state/incidentStore';
import { ConnectionBadge } from '../ConnectionBadge';
import { DisplayMenu } from '../DisplayMenu';
import { ShortcutsButton } from '../Shortcuts';
import { Toaster } from '../Toaster';
import { TourButton } from '../TourGuide';
import { Logo, PageLoading, navFor, teamsLabel, useFocusOnNavigate } from './shared';

const SIDEBAR_KEY = 'epicenter.sidebar';

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/**
 * The page's large title scrolls away with the content. Once it has gone under the toolbar, the
 * toolbar shows it in small, so the page keeps its name. Follows whichever h1 the page renders.
 */
function useInlineTitle(main: React.RefObject<HTMLElement | null>): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    const root = main.current;
    if (!root) return;
    let h1: HTMLElement | null = null;
    const io = new IntersectionObserver(
      ([entry]) => setTitle(entry && !entry.isIntersecting ? (entry.target.textContent ?? '').trim() || null : null),
      { root, rootMargin: '-56px 0px 0px 0px' },
    );
    const bind = () => {
      const next = root.querySelector<HTMLElement>('h1');
      if (next === h1) return;
      if (h1) io.unobserve(h1);
      h1 = next;
      if (h1) io.observe(h1);
      else setTitle(null);
    };
    bind();
    // Pages load on demand and swap their heading between loading and loaded states.
    const mo = new MutationObserver(bind);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      io.disconnect();
    };
  }, [main]);
  return title;
}

export function GlassShell() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const openIncidents = useIncidents((s) => selectOpenIncidents(s).length);
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigate(mainRef);
  const inlineTitle = useInlineTitle(mainRef);
  const items = navFor(user);

  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const toggleSidebar = () =>
    setSidebarOpen((open) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, open ? 'closed' : 'open');
      } catch {
        /* not remembered */
      }
      return !open;
    });

  const badge = (to: string) =>
    to === '/incidents' && openIncidents > 0 ? (
      <span className="min-w-5 rounded-full bg-crit px-1.5 text-center text-xs font-semibold leading-5 text-bg">
        {openIncidents}
        <span className="sr-only"> open</span>
      </span>
    ) : null;

  return (
    <div className="glass-shell relative h-full overflow-hidden" data-alert={openIncidents > 0 ? '' : undefined}>
      <div aria-hidden className="ambient">
        <span className="ambient-ring" />
        <span className="ambient-ring [animation-delay:2.5s]" />
        <span className="ambient-ring [animation-delay:5s]" />
      </div>

      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-accent-fill px-4 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* Sidebar: wide windows. It floats; the backdrop carries on beneath it. */}
      <aside id="glass-sidebar" className={`glass glass-thick absolute bottom-3 left-3 top-3 z-20 w-60 flex-col rounded-[1.375rem] ${sidebarOpen ? 'hidden md:flex' : 'hidden'}`}>
        <div className="flex h-14 shrink-0 items-center px-4">
          <Logo />
        </div>
        <nav aria-label="Main" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 py-1">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-h-9 items-center gap-3 rounded-xl px-3 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-fill-strong font-semibold text-fg' : 'font-medium text-fg hover:bg-fill'
                }`
              }
            >
              <Icon aria-hidden className="size-[1.125rem] shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {badge(to)}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="shrink-0 px-5 pb-4 pt-3">
            <div className="truncate text-sm font-semibold">{user.name}</div>
            <div className="truncate text-xs text-muted">{teamsLabel(user)}</div>
          </div>
        )}
      </aside>

      <main
        id="main"
        ref={mainRef}
        className={`relative h-full overflow-y-auto px-4 pb-32 pt-[4.5rem] outline-none md:pb-10 md:pr-6 ${sidebarOpen ? 'md:pl-[17.25rem]' : 'md:pl-6'}`}
      >
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </main>

      {/* Toolbar. Only its controls take the pointer; the band behind them is the scroll edge. */}
      <header className={`scroll-edge pointer-events-none absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-3 px-4 md:pr-6 ${sidebarOpen ? 'md:left-[16.5rem] md:pl-3' : 'md:pl-6'}`}>
        <button
          type="button"
          onClick={toggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="glass-sidebar"
          className="glass tool-btn pointer-events-auto hidden !px-0 md:inline-flex"
        >
          <PanelLeft aria-hidden className="size-[1.125rem]" />
          <span className="sr-only">{sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}</span>
        </button>
        <p aria-hidden className={`min-w-0 flex-1 truncate text-sm font-semibold transition-opacity duration-200 ${inlineTitle ? 'opacity-100' : 'opacity-0'}`}>
          {inlineTitle}
        </p>
        <div className="glass pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-full p-1">
          <ConnectionBadge bare />
          <TourButton className="tool-btn" showLabel={false} />
          <ShortcutsButton className="tool-btn" />
          <DisplayMenu buttonClassName="tool-btn" showLabel={false} />
          <button type="button" onClick={logout} className="tool-btn">
            <LogOut aria-hidden className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
            <span className="sr-only sm:hidden">Sign out</span>
          </button>
        </div>
      </header>

      <Toaster />

      {/* Tab bar: narrow windows. Floats above the content at the bottom, within reach of a thumb. */}
      <nav
        aria-label="Main"
        className="glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-md rounded-[1.75rem] p-1 md:hidden"
      >
        {items.map(({ to, label, short, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `relative flex min-h-[3.25rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-3xl px-1 text-[0.75rem] font-medium transition-colors ${
                isActive ? 'bg-fill-strong text-accent' : 'text-fg'
              }`
            }
          >
            <Icon aria-hidden className="size-[1.375rem]" />
            <span className="max-w-full truncate">{short ?? label}</span>
            {to === '/incidents' && openIncidents > 0 && <span className="absolute right-[calc(50%-1.5rem)] top-1">{badge(to)}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
