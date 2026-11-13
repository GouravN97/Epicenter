import { Activity, FlaskConical, LayoutGrid, LogOut, Network, Siren, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import type { Role } from '../lib/contract';
import { hasRole, useAuth } from '../state/authStore';
import { ConnectionBadge } from './ConnectionBadge';

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

export function AppShell() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const items = NAV.filter((n) => !n.roles || hasRole(user, ...n.roles));

  return (
    <div className="flex h-full">
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

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-24 md:px-6 md:pb-6">
          <Outlet />
        </main>
      </div>

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
