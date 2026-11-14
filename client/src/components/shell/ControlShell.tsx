// Shell of the control-room display mode: a fixed sidebar and header on desktop, a bottom tab bar on phones.
import { LogOut } from 'lucide-react';
import { Suspense, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../state/authStore';
import { ConnectionBadge } from '../ConnectionBadge';
import { DisplayMenu } from '../DisplayMenu';
import { Toaster } from '../Toaster';
import { Logo, PageLoading, navFor, teamsLabel, useFocusOnNavigate } from './shared';

const headerButton = 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg';

export function ControlShell() {
  const user = useAuth((s) => s.user);
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnNavigate(mainRef);
  const logout = useAuth((s) => s.logout);
  const items = navFor(user);

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
            <div className="truncate text-xs text-muted">{teamsLabel(user)}</div>
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
            <DisplayMenu buttonClassName={headerButton} />
            <button type="button" onClick={logout} className={headerButton}>
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
              `flex min-w-0 flex-1 flex-col items-center gap-1 px-1 py-2.5 text-mini ${isActive ? 'text-accent-strong' : 'text-muted'}`
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
