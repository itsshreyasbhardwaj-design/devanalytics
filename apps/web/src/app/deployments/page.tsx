import { listDeployments } from '@devanalytics/api';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { MetricTile } from '@/components/metric-tile';
import { TrendChart } from '@/components/trend-chart';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetrics, loadSeries, scopeFor } from '@/lib/data';

export const dynamic = 'force-dynamic';

const DEPLOY_METRICS = ['deployment_frequency', 'lead_time_for_changes', 'failed_deployment_rate'];

export default async function DeploymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const filters = readFilters(await searchParams);
  const scope = scopeFor(session.orgId, filters);
  const runtime = await getRuntime();

  const metrics = await loadMetrics(session.orgId, DEPLOY_METRICS, filters, scope);
  const frequency = await loadSeries(session.orgId, 'deployment_frequency', filters, scope);
  const leadTime = await loadSeries(session.orgId, 'lead_time_for_changes', filters, scope);

  const deployments = await listDeployments(runtime.db, session.orgId, {
    ...(filters.repositoryIds[0] ? { repoId: filters.repositoryIds[0] } : {}),
    productionOnly: filters.productionOnly,
    limit: 50, offset: 0,
  });

  const leadTimeMetric = metrics.find((m) => m.metric === 'lead_time_for_changes');

  return (
    <>
      <PageHeader
        title="Deployments"
        description={`Deployment frequency and lead time for changes, over ${filters.productionOnly ? 'production environments only' : 'all environments'}.`}
        window={describeWindow(filters.window)}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {metrics.map((m) => (
          <MetricTile key={m.metric} metric={m.metric} result={m.value.result} comparison={m.comparison} href={`/metrics/${m.metric}`} />
        ))}
      </div>

      {leadTimeMetric?.value.excluded && (
        <Card className="mb-6 border-amber-900/60 bg-amber-950/20">
          <CardContent className="text-xs text-amber-200">
            <strong>{leadTimeMetric.value.excluded.count} deployments excluded from lead time.</strong>{' '}
            {leadTimeMetric.value.excluded.reason} Link deployments to a pull request (via the merge commit SHA) to include them.
          </CardContent>
        </Card>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Deployment frequency</CardTitle></CardHeader>
          <CardContent><TrendChart points={frequency} unitLabel="per day" color="#34d399" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Lead time for changes</CardTitle></CardHeader>
          <CardContent><TrendChart points={leadTime} unitLabel="hours" /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Recent deployments</CardTitle></CardHeader>
        <CardContent className="p-0">
          {(deployments as unknown[]).length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-slate-500">No deployments in this window.</p>
          ) : (
            <Table>
              <thead>
                <tr><Th>Repository</Th><Th>Environment</Th><Th>State</Th><Th>Commit</Th><Th className="text-right">Created</Th></tr>
              </thead>
              <tbody>
                {(deployments as Record<string, unknown>[]).map((d) => (
                  <tr key={String(d.id)}>
                    <Td className="text-slate-300">{String(d.repository)}</Td>
                    <Td>
                      {String(d.environment)}
                      {d.is_production === true && <Badge tone="info" className="ml-1.5">production</Badge>}
                    </Td>
                    <Td><Badge tone={d.state === 'success' ? 'good' : d.state === 'failure' || d.state === 'error' ? 'bad' : 'muted'}>{String(d.state)}</Badge></Td>
                    <Td className="font-mono text-[11px] text-slate-500">{String(d.sha).slice(0, 10)}</Td>
                    <Td className="text-right font-mono text-[11px] text-slate-500">{new Date(String(d.created_at)).toISOString().slice(0, 16).replace('T', ' ')}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
