import { ShieldAlert } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '../lib/contract';
import { hasRole, useAuth } from '../state/authStore';
import { EmptyState } from './EmptyState';

/** Sends anonymous visitors to /login and remembers where they were going. */
export function ProtectedRoute() {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === 'checking') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted" role="status">
        Checking session…
      </div>
    );
  }
  if (status === 'anon') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** UI guard only. The server enforces the same rule on every route and room (plan §6, §7.2). */
export function RequireRole({ roles }: { roles: Role[] }) {
  const user = useAuth((s) => s.user);
  if (!hasRole(user, ...roles)) {
    return (
      <EmptyState
        icon={<ShieldAlert aria-hidden className="size-6" />}
        title="Not available for your role"
        body={`This page needs the ${roles.join(' or ')} role. You are signed in as ${user?.role ?? 'unknown'}.`}
      />
    );
  }
  return <Outlet />;
}
