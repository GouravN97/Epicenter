import { CircleCheck, OctagonAlert, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react';

// Status is always icon + label + colour, never colour alone (plan §9.3).
export const STATUS_VIEW: readonly { name: string; label: string; icon: LucideIcon; text: string }[] = [
  { name: 'ok', label: 'Healthy', icon: CircleCheck, text: 'text-ok' },
  { name: 'warn', label: 'Warning', icon: TriangleAlert, text: 'text-warn' },
  { name: 'crit', label: 'Critical', icon: OctagonAlert, text: 'text-crit' },
  { name: 'silent', label: 'Silent', icon: WifiOff, text: 'text-silent' },
];

export function StatusIcon({ status, className = 'size-4' }: { status: number; className?: string }) {
  const v = STATUS_VIEW[status] ?? STATUS_VIEW[0]!;
  const Icon = v.icon;
  return <Icon aria-hidden className={`${className} ${v.text} shrink-0`} />;
}
