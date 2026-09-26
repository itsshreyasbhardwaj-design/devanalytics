import Link from 'next/link';
import { listWorkflowRuns } from '@devanalytics/api';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { MetricTile } from '@/components/metric-tile';
import { TrendChart } from '@/components/trend-chart';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetrics, loadSeries, scopeFor } from '@/lib/data';

export const dynamic = 'force-dynamic';

const CI_METRICS = ['build_success_rate', 'build_duration', 'ci_queue_time'];

export default async function CiPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const sp = await searchParams;
  const filters = readFilters(sp);
  const scope = scopeFor(session.orgId, filters);
  const runtime = await getRuntime();

  const metrics = await loadMetrics(session.orgId, CI_METRICS, filters, scope);
  const [successSeries, durationSeries, queueSeries] = await Promise.all([
    loadSeries(session.orgId, 'build_success_rate', filters, scope),
    loadSeries(session.orgId, 'build_duration', filters, scope),
    loadSeries(session.orgId, 'ci_queue_time', filters, scope),
  ]);

  const failures = await runtime.db.withOrg(session.orgId, (sql) =>
    sql.many<{ workflow: string; repository: string; branch: string | null; failures: number; total: number; rate: number }>(
      `select w.name as workflow, r.full_name as repository, wr.head_branch as branch,
              count(*) filter (where wr.conclusion = 'failure')::int as failures,
              count(*)::int as total,
              (count(*) filter (where wr.conclusion = 'failure')::float / count(*)) as rate
         from workflow_runs wr
         join workflows w on w.id = wr.workflow_id
         join repositories r on r.id = wr.repo_id
        where wr.created_at >= $1::timestamptz and wr.created_at < $2::timestamptz
          and wr.conclusion in ('success','failure','timed_out')
        group by 1,2,3
       having count(*) filter (where wr.conclusion = 'failure') > 0
        order by failures desc limit 15`,
      [filters.window.from, filters.window.to],
    ), 'readonly');

  const runs = await listWorkflowRuns(runtime.db, session.orgId, {
    ...(filters.repositoryIds[0] ? { repoId: filters.repositoryIds[0] } : {}),
    limit: 40, offset: 0,
  });

  return (
    <>
      <PageHeader
        title="Continuous integration"
        description="Build reliability, duration and queue time are reported separately. A slow pipeline and a starved runner pool look identical if you add duration and queue time together."
        window={describeWindow(filters.window)}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {metrics.map((m) => (
          <MetricTile key={m.metric} metric={m.metric} result={m.value.result} comparison={m.comparison} href={`/metrics/${m.metric}`} />
        ))}
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Build success rate</CardTitle></CardHeader>
          <CardContent><TrendChart points={successSeries} unitLabel="ratio" height={180} color="#34d399" /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Build duration</CardTitle></CardHeader>
          <CardContent><TrendChart points={durationSeries} unitLabel="minutes" height={180} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Queue time</CardTitle></CardHeader>
          <CardContent><TrendChart points={queueSeries} unitLabel="minutes" height={180} color="#fbbf24" /></CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Where builds fail</CardTitle>
          <p className="text-xs text-slate-500">
            Grouped by workflow, repository and branch. Descriptive only — a high rate here is where to look, not why it happens.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {failures.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-slate-500">No failing runs in this window.</p>
          ) : (
            <Table>
              <thead>
                <tr><Th>Workflow</Th><Th>Repository</Th><Th>Branch</Th><Th className="text-right">Failures</Th><Th className="text-right">Runs</Th><Th className="text-right">Rate</Th></tr>
              </thead>
              <tbody>
                {failures.map((f, i) => (
                  <tr key={i}>
                    <Td>{f.workflow}</Td>
                    <Td className="text-slate-400">{f.repository}</Td>
                    <Td className="font-mono text-[11px] text-slate-500">{f.branch ?? '—'}</Td>
                    <Td className="text-right tabular-nums text-rose-400">{f.failures}</Td>
                    <Td className="text-right tabular-nums text-slate-500">{f.total}</Td>
                    <Td className="text-right tabular-nums">{(Number(f.rate) * 100).toFixed(1)}%</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent runs</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr><Th>Workflow</Th><Th>Repository</Th><Th>Branch</Th><Th>Outcome</Th><Th className="text-right">Created</Th><Th className="text-right">Attempt</Th></tr>
            </thead>
            <tbody>
              {(runs as Record<string, unknown>[]).map((r) => (
                <tr key={String(r.id)}>
                  <Td>{String(r.name)}</Td>
                  <Td className="text-slate-400">{String(r.repository)}</Td>
                  <Td className="font-mono text-[11px] text-slate-500">{r.head_branch ? String(r.head_branch) : '—'}</Td>
                  <Td>
                    <Badge tone={r.conclusion === 'success' ? 'good' : r.conclusion === 'failure' ? 'bad' : 'muted'}>
                      {r.conclusion ? String(r.conclusion) : String(r.status)}
                    </Badge>
                  </Td>
                  <Td className="text-right font-mono text-[11px] text-slate-500">{new Date(String(r.created_at)).toISOString().slice(0, 16).replace('T', ' ')}</Td>
                  <Td className="text-right tabular-nums text-slate-500">
                    {Number(r.run_attempt) > 1 ? <span className="text-amber-400">#{String(r.run_attempt)}</span> : String(r.run_attempt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-slate-500">
        Each retry counts as a separate run, so a flaky job that passes on attempt three lowers the success rate. That is intentional —
        see <Link href="/metrics/build_success_rate" className="text-sky-400 hover:underline">the metric definition</Link>.
      </p>
    </>
  );
}
