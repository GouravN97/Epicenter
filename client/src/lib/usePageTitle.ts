import { useEffect } from 'react';

/** Sets the tab title to "<title> · Epicenter" while the page is mounted. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Epicenter` : 'Epicenter';
  }, [title]);
}
