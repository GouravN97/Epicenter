// What both shells share: the navigation model, the logo, the loading state and focus handling.
import { Activity, FlaskConical, LayoutGrid, Network, Siren, type LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import type { Role, UserDTO } from '@epicenter/shared';
import { hasRole } from '../../state/authStore';

export interface NavItem {
  to: string;
  label: string;
  /** One word, for the phone tab bar. */
  short?: string;
  icon: LucideIcon;
  roles?: Role[];
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid },
  { to: '/topology', label: 'Topology', icon: Network },
  { to: '/incidents', label: 'Incidents', icon: Siren },
  { to: '/chaos', label: 'Chaos Lab', short: 'Chaos', icon: FlaskConical, roles: ['admin'] },
  { to: '/pipeline', label: 'Pipeline', icon: Activity },
];

export const navFor = (user: UserDTO | null): NavItem[] => NAV.filter((n) => !n.roles || hasRole(user, ...n.roles));

export const teamsLabel = (user: UserDTO): string => `${user.role} · ${user.teams.length === 4 ? 'all teams' : user.teams.join(', ')}`;

export function LogoMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} text-accent`} fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6" strokeWidth="1.5" opacity="0.6" />
      <circle cx="12" cy="12" r="10" strokeWidth="1.5" opacity="0.25" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">Epicenter</span>
    </div>
  );
}

export function PageLoading() {
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
export function useFocusOnNavigate(main: React.RefObject<HTMLElement | null>) {
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
