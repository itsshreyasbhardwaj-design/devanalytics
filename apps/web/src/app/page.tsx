import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Badge } from '@devanalytics/ui';
import { requireMetricDefinition } from '@devanalytics/metrics';
import { listAnomalies, organizationSummary } from '@devanalytics/api';
import { MetricTile } from '@/components/metric-tile';
import { TrendChart } from '@/components/trend-chart';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetrics, loadSeries, scopeFor } from '@/lib/data';

export const dynamic = 'force-dynamic';

const DELIVERY = ['pr_cycle_time', 'time_to_first_review', 'review_turnaround_time', 'merge_time', 'pr_size'];
const DORA = ['deployment_frequency', 'lead_time_for_changes', 'failed_deployment_rate', 'build_success_rate'];
const FLOW = ['ci_queue_time', 'build_duration', 'review_participation', 'commit_frequency', 'reopened_pr_rate'];

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) {
    return (
      <EmptyState
        title="No organization yet"
        description="Connect a repository or load the demo organization to see metrics. Until real events are ingested, this dashboard shows nothing rather than placeholder numbers."
        action={<Link href="/settings" className="text-xs text-sky-400 underline">Go to settings</Link>}
      />
    );
  }

  const filters = readFilters(await searchParams);
  const scope = scopeFor(session.orgId, filters);
  const runtime = await getRuntime();

  const [delivery, dora, flow] = await Promise.all([
    loadMetrics(session.orgId, DELIVERY, filters, scope),
    loadMetrics(session.orgId, DORA, filters, scope),
    loadMetrics(session.orgId, FLOW, filters, scope),
  ]);

  const cycleSeries = await loadSeries(session.orgId, 'pr_cycle_time', filters, scope);
  const summary = await organizationSummary(runtime.db, session.orgId);
  const volumes = await runtime.db.withOrg(session.orgId, (sql) =>
    sql.one<{ prs: number; runs: number; deployments: number }>(
      `select (select count(*)::int from pull_requests) as prs,
              (select count(*)::int from workflow_runs) as runs,
              (select count(*)::int from deployments) as deployments`,
    ), 'readonly');
  const anomalies = await listAnomalies(runtime.db, session.orgId, { status: 'open', limit: 5 });

  const hasAnyData = [...delivery, ...dora, ...flow].some((m) => m.value.result.status === 'ok');

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          `Delivery, review, CI and deployment metrics for ${session.orgName}, computed from ` +
          `${Number(volumes?.prs ?? 0).toLocaleString('en-US')} pull requests, ` +
          `${Number(volumes?.runs ?? 0).toLocaleString('en-US')} CI runs and ` +
          `${Number(volumes?.deployments ?? 0).toLocaleString('en-US')} deployments` +
          (Number(summary?.events ?? 0) > 0
            ? ` from ${Number(summary?.events ?? 0).toLocaleString('en-US')} ingested events.`
            : '. This organization was generated directly rather than through the webhook pipeline, so the event log is empty.')
        }
        window={describeWindow(filters.window)}
        right={<Badge tone={scope.scopeType === 'org' ? 'muted' : 'info'}>{scope.scopeType} scope</Badge>}
      />

      {!hasAnyData && (
        <div className="mb-6">
          <EmptyState
            title="Not enough data in this window"
            description="No metric in this period has reached its minimum sample size. Widen the time range, or check that webhooks are arriving under Settings. Nothing is estimated to fill the gap."
          />
        </div>
      )}

      <section aria-labelledby="delivery" className="mb-8">
        <h2 id="delivery" className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Delivery and review</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {delivery.map((m) => (
            <MetricTile key={m.metric} metric={m.metric} result={m.value.result} comparison={m.comparison} href={`/metrics/${m.metric}`} />
          ))}
        </div>
      </section>

      <section aria-labelledby="dora" className="mb-8">
        <h2 id="dora" className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Delivery performance</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {dora.map((m) => (
            <MetricTile key={m.metric} metric={m.metric} result={m.value.result} comparison={m.comparison} href={`/metrics/${m.metric}`} />
          ))}
        </div>
      </section>

      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>PR cycle time</CardTitle>
            <p className="text-xs text-slate-400">{requireMetricDefinition('pr_cycle_time').formula}</p>
          </CardHeader>
          <CardContent>
            <TrendChart points={cycleSeries} unitLabel="hours" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open anomalies</CardTitle>
            <p className="text-xs text-slate-400">Movements unusual against each scope&rsquo;s own history.</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {anomalies.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-400">
                Nothing unusual detected in the periods examined. Detection needs at least 14 prior periods before it will judge a metric.
              </p>
            ) : (
              anomalies.map((a) => {
                const row = a as Record<string, unknown>;
                return (
                  <Link
                    key={String(row.id)}
                    href={`/anomalies#${String(row.id)}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 px-3 py-2 text-xs hover:border-slate-700"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-slate-200">{requireMetricDefinition(String(row.metric)).name}</p>
                      <p className="truncate text-[11px] text-slate-400">{String(row.scope_label)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge tone={row.severity === 'high' ? 'bad' : row.severity === 'medium' ? 'warn' : 'neutral'}>{String(row.severity)}</Badge>
                      <Badge tone="muted">{String(row.confidence)} confidence</Badge>
                    </div>
                  </Link>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="flow">
        <h2 id="flow" className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Flow and quality</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {flow.map((m) => (
            <MetricTile key={m.metric} metric={m.metric} result={m.value.result} comparison={m.comparison} href={`/metrics/${m.metric}`} compact />
          ))}
        </div>
      </section>
    </>
  );
}
