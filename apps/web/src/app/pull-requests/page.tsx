import Link from 'next/link';
import { listPullRequests } from '@devanalytics/db';
import { Badge, Card, CardContent, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';
import { describeWindow } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function PullRequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const sp = await searchParams;
  const filters = readFilters(sp);
  const state = typeof sp.state === 'string' ? sp.state : undefined;
  const runtime = await getRuntime();

  const rows = await runtime.db.withOrg(session.orgId, (sql) =>
    listPullRequests(sql, {
      ...(filters.repositoryIds[0] ? { repoId: filters.repositoryIds[0] } : {}),
      ...(state ? { state } : {}),
      from: filters.window.from,
      to: filters.window.to,
      limit: 100,
    }), 'readonly');

  const hours = (a: string | null, b: string | null) =>
    a && b ? ((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000).toFixed(1) : null;

  return (
    <>
      <PageHeader
        title="Pull requests"
        description="Individual pull requests opened in this window, with the timestamps every delivery metric is derived from."
        window={describeWindow(filters.window)}
        right={
          <div className="flex gap-1">
            {['all', 'open', 'merged', 'closed'].map((s) => (
              <Link
                key={s}
                href={`/pull-requests?period=${filters.period}${s === 'all' ? '' : `&state=${s}`}`}
                className={`rounded-md border px-2 py-1 text-xs ${(state ?? 'all') === s ? 'border-sky-600 bg-sky-950/60 text-sky-300' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
              >
                {s}
              </Link>
            ))}
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No pull requests in this window"
          description="Widen the time range, or clear the repository filter. Nothing is shown here that was not ingested from the provider."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Repository</Th><Th>#</Th><Th>Title</Th><Th>Author</Th><Th>State</Th>
                  <Th className="text-right">Size</Th>
                  <Th className="text-right">To first review</Th>
                  <Th className="text-right">Cycle time</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-900/50">
                    <Td className="max-w-40 truncate text-slate-400">{p.repoFullName}</Td>
                    <Td className="tabular-nums text-slate-400">{p.number}</Td>
                    <Td className="max-w-sm truncate">
                      <Link href={`/pull-requests/${p.id}`} className="hover:text-sky-400">{p.title}</Link>
                    </Td>
                    <Td className="text-slate-400">{p.authorLogin ?? '—'}</Td>
                    <Td>
                      <Badge tone={p.state === 'merged' ? 'good' : p.state === 'open' ? 'info' : 'muted'}>{p.state}</Badge>
                      {p.reopenedCount > 0 && <Badge tone="warn" className="ml-1">reopened</Badge>}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {p.additions === null || p.deletions === null ? (
                        <span className="text-xs text-slate-400" title="This provider does not report diff statistics on its webhooks">
                          not reported
                        </span>
                      ) : (
                        (p.additions + p.deletions).toLocaleString('en-US')
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{hours(p.readyForReviewAt, p.firstReviewAt) ?? <span className="text-slate-400">—</span>}</Td>
                    <Td className="text-right tabular-nums">{hours(p.readyForReviewAt, p.mergedAt) ?? <span className="text-slate-400">—</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
