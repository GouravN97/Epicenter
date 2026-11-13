import type { ReactNode } from 'react';

export function EmptyState({ icon, title, body }: { icon?: ReactNode; title: string; body?: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-12 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <h2 className="text-sm font-medium text-fg">{title}</h2>
      {body && <p className="mt-1 max-w-md text-sm text-muted">{body}</p>}
    </div>
  );
}
