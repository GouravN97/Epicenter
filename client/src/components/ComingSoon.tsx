import { Hammer } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { PageHeader } from './PageHeader';

/** Placeholder body for pages whose task has not been built yet. */
export function ComingSoon({ title, subtitle, task }: { title: string; subtitle?: string; task: string }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState icon={<Hammer aria-hidden className="size-6" />} title="Not built yet" body={`This page arrives with task ${task}.`} />
    </>
  );
}
