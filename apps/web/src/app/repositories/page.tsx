import Link from 'next/link';
import { listOrgRepositories } from '@devanalytics/api';
import { formatMetric } from '@devanalytics/metrics';
import { INSUFFICIENT_DATA_LABEL } from '@devanalytics/core';
import { Badge, Card, CardContent, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, filtersToQuery, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetric } from '@/lib/data';

export const dynamic = 'force-dynamic';

const COLUMNS = ['pr_cycle_time', 'time_to_first_review', 'build_success_rate', 'deployment_frequency'];

export default async function RepositoriesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const filters = readFilters(await searchParams);
  const runtime = await getRuntime();
  const repos = await listOrgRepositories(runtime.db, session.orgId);

  const rows = [];
  for (const repo of repos) {
    const metrics = [];
    for (const metric of COLUMNS) {
      metrics.push(await loadMetric(session.orgId, metric, filters, { scopeType: 'repository', scopeId: repo.id }));
    }
    rows.push({ repo, metrics });
  }

  const query = filtersToQuery(filters);

  return (
    <>
      <PageHeader
        title="Repositories"
        description="Health per repository. Each metric is reported on its own with its own sample size; there is no composite score, because a single number hides which of these is actually wrong."
        window={describeWindow(filters.window)}
      />

      {repos.length === 0 ? (
        <EmptyState
          title="No repositories connected"
          description="Connect a repository to start ingesting pull requests, reviews, CI runs and deployments."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Repository</Th>
                  <Th className="text-right">Open PRs</Th>
                  {COLUMNS.map((c) => <Th key={c} className="text-right">{shortLabel(c)}</Th>)}
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ repo, metrics }) => (
                  <tr key={repo.id} className="hover:bg-slate-900/50">
                    <Td>
                      <Link href={`/repositories/${repo.id}${query}`} className="font-medium text-slate-100 hover:text-sky-400">
                        {repo.fullName}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Badge tone="muted">{repo.defaultBranch}</Badge>
                        {repo.isPrivate && <Badge tone="muted">private</Badge>}
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">{repo.openPullRequests}</Td>
                    {metrics.map((m) => (
                      <Td key={m.metric} className="text-right tabular-nums">
                        {m.value.result.status === 'ok' ? (
                          <span className="text-slate-200">{formatMetric(m.metric, m.value.result)}</span>
                        ) : (
                          <span className="text-[11px] text-slate-500" title={`${m.value.result.sampleSize} of ${m.value.result.minimumSampleSize} observations`}>
                            {INSUFFICIENT_DATA_LABEL}
                          </span>
                        )}
                        <div className="text-[10px] text-slate-600">{m.value.result.sampleSize} obs</div>
                      </Td>
                    ))}
                    <Td className="text-right">
                      <Link href={`/repositories/${repo.id}${query}`} className="text-xs text-sky-400 hover:underline">Open</Link>
                    </Td>
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

function shortLabel(metric: string): string {
  switch (metric) {
    case 'pr_cycle_time': return 'Cycle time';
    case 'time_to_first_review': return 'First review';
    case 'build_success_rate': return 'Build success';
    case 'deployment_frequency': return 'Deploys';
    default: return metric;
  }
}
