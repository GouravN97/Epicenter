import { Activity, FlaskConical, LayoutGrid, LogOut, Network, Siren, type LucideIcon } from 'lucide-react';
import { Suspense, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@epicenter/shared';
import { hasRole, useAuth } from '../state/authStore';
import { ConnectionBadge } from './ConnectionBadge';
import { Toaster } from './Toaster';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles?: Role[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid },
  { to: '/topology', label: 'Topology', icon: Network },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/chaos', label: 'Chaos Lab', icon: FlaskConical, roles: ['admin'] },
  { to: '/pipeline', label: 'Pipeline', icon: Activity },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 24 24" className="size-6 text-accent" fill="none" stroke="currentColor" aria-hidden>
        <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="6" strokeWidth="1.5" opacity="0.6" />
        <circle cx="12" cy="12" r="10" strokeWidth="1.5" opacity="0.25" />
      </svg>
      <span className="text-base font-semibold tracking-tight">Epicenter</span>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-muted" role="status">
      Loading…
    </div>
  );
}

/**
 * After a navigation, move focus to the new page's heading (or the main area) so keyboard and screen-reader
 * users start at the top of the new page instead of on a link that is no longer relevant.
 */
function useFocusOnNavigate(main: React.RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  // Compare with the last path rather than skipping the first run: React runs effects twice in development.
  const last = useRef(pathname);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    const el = main.current;
    if (!el) return;
    el.scrollTop = 0;
    // Pages load on demand: wait briefly for the heading to appear.
    let tries = 0;
    const t = setInterval(() => {
      const h1 = el.querySelector<HTMLElement>('h1');
      if (h1 || ++tries > 20) {
        clearInterval(t);
        const target = h1 ?? el;
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }, 50);
    return () => clearInterval(t);
  }, [pathname, main]);
}

export function AppShell() {
  const user = useAuth((s) => s.user);
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigate(mainRef);
  const logout = useAuth((s) => s.logout);
  const items = NAV.filter((n) => !n.roles || hasRole(user, ...n.roles));

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-medium text-bg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      {/* Sidebar: desktop and tablet */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-14 items-center px-4">
          <Logo />
        </div>
        <nav aria-label="Main" className="flex-1 space-y-1 px-2 py-2">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:bg-raised hover:text-fg'
                }`
              }
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="border-t border-line p-3">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-muted">
              {user.role} · {user.teams.length === 4 ? 'all teams' : user.teams.join(', ')}
            </div>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
          <div className="md:hidden">
            <Logo />
          </div>
          <div className="hidden md:block" />
          <div className="flex items-center gap-2">
            <ConnectionBadge />
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg"
            >
              <LogOut aria-hidden className="size-4" />
              <span className="hidden sm:inline">Sign out</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </button>
          </div>
        </header>

        <main id="main" ref={mainRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-24 outline-none md:px-6 md:pb-6">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <Toaster />

      {/* Bottom tab bar: phones */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2.5 text-[11px] ${
                isActive ? 'text-accent-strong' : 'text-muted'
              }`
            }
          >
            <Icon aria-hidden className="size-5" />
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
