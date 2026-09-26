import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * A saved investigation re-runs against its stored windows.
 *
 * Deliberately not a frozen snapshot: if events arrived late — and with
 * webhooks they do — the honest answer is the current one over the same
 * period, not the number that happened to be computed first.
 */
export default async function SavedInvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (session.empty) notFound();

  const runtime = await getRuntime();
  const stored = await runtime.db.withOrg(session.orgId, (sql) =>
    sql.one<{ metric: string; scope_type: string; scope_id: string; window_start: Date; window_end: Date }>(
      `select metric, scope_type, scope_id, window_start, window_end from investigations where id = $1`,
      [id],
    ), 'readonly');
  if (!stored) notFound();

  const params2 = new URLSearchParams({
    metric: stored.metric,
    scopeType: stored.scope_type,
    scopeId: stored.scope_id,
    from: new Date(stored.window_start).toISOString(),
    to: new Date(stored.window_end).toISOString(),
  });
  redirect(`/investigations?${params2.toString()}`);
}
