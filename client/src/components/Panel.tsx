import type { ReactNode } from 'react';

/** Titled surface used for each dashboard section. */
export function Panel({
  title,
  actions,
  children,
  className = '',
  tour,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Anchor name the guided tour can point at (`data-tour`). */
  tour?: string;
}) {
  return (
    <section data-tour={tour} className={`card flex min-w-0 flex-col ${className}`}>
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="panel-title">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
