import { TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { usePageTitle } from '../lib/usePageTitle';

/** Shown in place of a page that failed to render or to load. */
export function RouteError() {
  const err = useRouteError();
  usePageTitle('Something went wrong');
  // A page chunk that no longer exists (the app was redeployed while this tab was open) needs a reload.
  const message = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : 'Unknown error';
  const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(message);
  return (
    <div role="alert" className="mx-auto flex min-h-64 max-w-lg flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <TriangleAlert aria-hidden className="size-7 text-warn" />
      <h1 className="text-lg font-semibold">{stale ? 'A newer version of Epicenter is available' : 'This page ran into a problem'}</h1>
      <p className="text-sm text-muted">
        {stale ? 'Reload to get it. Live data resumes where it left off.' : 'The rest of the app still works. Reloading usually fixes it.'}
      </p>
      {!stale && <p className="metric max-w-full truncate rounded bg-raised px-2 py-1 text-xs text-muted">{message}</p>}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="btn-primary"
      >
        Reload
      </button>
    </div>
  );
}
