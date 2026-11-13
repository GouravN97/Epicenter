import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export function NotFound() {
  return (
    <div className="space-y-4">
      <EmptyState icon={<Compass aria-hidden className="size-6" />} title="Page not found" body="That address does not match any page." />
      <p className="text-center text-sm">
        <Link to="/" className="text-accent hover:text-accent-strong">
          Back to Overview
        </Link>
      </p>
    </div>
  );
}
