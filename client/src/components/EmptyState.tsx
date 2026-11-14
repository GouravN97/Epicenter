import type { ReactNode } from 'react';
import { usePageTitle } from '../lib/usePageTitle';

/**
 * `page` when the empty state is the whole page (not found, no access): its title becomes the page's h1 and
 * the tab title, so the page is announced and focusable like any other.
 */
export function EmptyState({ icon, title, body, page = false }: { icon?: ReactNode; title: string; body?: string; page?: boolean }) {
  return page ? <PageEmptyState icon={icon} title={title} body={body} /> : <Box icon={icon} title={title} body={body} heading="h2" />;
}

function PageEmptyState(props: { icon?: ReactNode; title: string; body?: string }) {
  usePageTitle(props.title);
  return <Box {...props} heading="h1" />;
}

function Box({ icon, title, body, heading: H }: { icon?: ReactNode; title: string; body?: string; heading: 'h1' | 'h2' }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <H className="text-sm font-medium text-fg">{title}</H>
      {body && <p className="mt-1 max-w-md text-sm text-muted">{body}</p>}
    </div>
  );
}
