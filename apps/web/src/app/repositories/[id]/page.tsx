import Link from 'next/link';
import { notFound } from 'next/navigation';
import { repositoryHealth } from '@devanalytics/api';
import { requireMetricDefinition } from '@devanalytics/metrics';
import { INSUFFICIENT_DATA_LABEL } from '@devanalytics/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@devanalytics/ui';
import { TrendChart } from '@/components/trend-chart';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, filtersToQuery, type SearchParams } from '@/lib/filters';
import { describeWindow, loadSeries } from '@/lib/data';

export const dynamic = 'force-dynamic';

export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (session.empty) notFound();

  const filters = readFilters(await searchParams);
  const runtime = await getRuntime();

  let health;
  try {
    health = await repositoryHealth(runtime.db, runtime.engine, { orgId: session.orgId, repoId: id, window: filters.window });
  } catch {
    notFound();
  }

  const cycle = await loadSeries(session.orgId, 'pr_cycle_time', filters, { scopeType: 'repository', scopeId: id });
  const builds = await loadSeries(session.orgId, 'build_success_rate', filters, { scopeType: 'repository', scopeId: id });

  const prs = await runtime.db.withOrg(session.orgId, (sql) =>
    sql.many<{ id: string; number: number; title: string; state: string; login: string | null; hours: number | null }>(
      `select p.id, p.number, p.title, p.state, u.login,
              extract(epoch from (p.merged_at - p.ready_for_review_at)) / 3600.0 as hours
         from pull_requests p left join users u on u.id = p.author_user_id
        where p.repo_id = $1 and p.created_at >= $2::timestamptz and p.created_at < $3::timestamptz
        order by p.created_at desc limit 15`,
      [id, filters.window.from, filters.window.to],
    ), 'readonly');

  const query = filtersToQuery(filters);

  return (
    <>
      <PageHeader
        title={health.fullName}
        description={`${health.teamName ? `Owned by ${health.teamName}. ` : ''}Default branch ${health.defaultBranch}. ${health.openPullRequests} open pull requests.`}
        window={describeWindow(filters.window)}
        right={<Link href={`/pull-requests?repositoryId=${id}`} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">Pull requests</Link>}
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Health</CardTitle>
          <p className="text-xs text-slate-400">
            Ten named metrics, each with its own sample size. Deliberately not reduced to one score.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr><Th>Metric</Th><Th className="text-right">Value</Th><Th className="text-right">Change</Th><Th className="text-right">Observations</Th></tr>
            </thead>
            <tbody>
              {health.metrics.map((m) => {
                const improving = m.relativeChange === null || m.direction === 'neutral'
                  ? null
                  : m.direction === 'lower_is_better' ? m.relativeChange < 0 : m.relativeChange > 0;
                return (
                  <tr key={m.metric}>
                    <Td><Link href={`/metrics/${m.metric}${query}`} className="hover:text-sky-400">{m.name}</Link></Td>
                    <Td className="text-right tabular-nums">
                      {m.status === 'ok' ? m.value : <span className="text-slate-400">{INSUFFICIENT_DATA_LABEL}</span>}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {m.relativeChange === null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className={improving === null ? 'text-slate-400' : improving ? 'text-emerald-400' : 'text-rose-400'}>
                          {m.relativeChange >= 0 ? '+' : ''}{(m.relativeChange * 100).toFixed(1)}%
                        </span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums text-slate-400">{m.sampleSize}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{requireMetricDefinition('pr_cycle_time').name}</CardTitle></CardHeader>
          <CardContent><TrendChart points={cycle} unitLabel="hours" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{requireMetricDefinition('build_success_rate').name}</CardTitle></CardHeader>
          <CardContent><TrendChart points={builds} unitLabel="ratio" color="#34d399" /></CardContent>
        </Card>
      </div>

      {health.recentAnomalies.length > 0 && (
        <Card className="mb-6">
          <CardHeader><CardTitle>Recent anomalies</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {health.recentAnomalies.map((a) => (
              <Badge key={a.id} tone={a.severity === 'high' ? 'bad' : 'warn'}>
                {requireMetricDefinition(a.metric).name} · {a.severity} · {a.confidence} confidence
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Recent pull requests</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr><Th>#</Th><Th>Title</Th><Th>Author</Th><Th>State</Th><Th className="text-right">Cycle time</Th></tr>
            </thead>
            <tbody>
              {prs.map((p) => (
                <tr key={p.id} className="hover:bg-slate-900/50">
                  <Td className="tabular-nums text-slate-400">{p.number}</Td>
                  <Td className="max-w-md truncate">
                    <Link href={`/pull-requests/${p.id}`} className="hover:text-sky-400">{p.title}</Link>
                  </Td>
                  <Td className="text-slate-400">{p.login ?? '—'}</Td>
                  <Td><Badge tone={p.state === 'merged' ? 'good' : p.state === 'open' ? 'info' : 'muted'}>{p.state}</Badge></Td>
                  <Td className="text-right tabular-nums">{p.hours === null ? '—' : `${Number(p.hours).toFixed(1)} h`}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
