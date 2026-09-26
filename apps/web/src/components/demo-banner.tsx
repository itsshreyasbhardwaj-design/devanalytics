import { FlaskConical } from 'lucide-react';

/**
 * Demo labelling.
 *
 * Rendered on every page of a demo organization. Synthetic numbers that are not
 * visibly synthetic are worse than no numbers, so this is not dismissible and
 * does not depend on the user having read a settings page.
 */
export function DemoBanner({ orgName }: { orgName: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-900/60 bg-amber-950/40 px-6 py-2 text-xs text-amber-200"
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Demo data.</strong> {orgName} is a generated organization. Every figure on this
        page is computed from synthetic events and describes no real engineering activity.
      </span>
    </div>
  );
}
