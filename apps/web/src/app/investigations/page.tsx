import Link from 'next/link';
import { INSUFFICIENT_DATA_LABEL, previousWindow, type ScopeType } from '@devanalytics/core';
import { formatMetric, getMetricDefinition, requireMetricDefinition } from '@devanalytics/metrics';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { TrendChart } from '@/components/trend-chart';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';
import { describeWindow, loadSeries } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * Investigation view.
 *
 * Runs live when a metric is supplied, so an anomaly link goes straight to an
 * answer. The structure is deliberate: what moved, what accounts for it
 * arithmetically, what moved alongside it, and the records underneath. The
 * contribution table separates a slice getting worse from a slice getting
 * bigger, because those need different responses.
 */
export default async function InvestigationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const sp = await searchParams;
  const filters = readFilters(sp);
  const metric = typeof sp.metric === 'string' ? sp.metric : null;
  const scopeType = (typeof sp.scopeType === 'string' ? sp.scopeType : 'org') as ScopeType;
  const scopeId = typeof sp.scopeId === 'string' ? sp.scopeId : session.orgId;
  const runtime = await getRuntime();

  if (!metric || !getMetricDefinition(metric)) {
    const saved = await runtime.db.withOrg(session.orgId, (sql) =>
      sql.many<{ id: string; metric: string; title: string; window_start: Date; window_end: Date; created_at: Date }>(
        `select id, metric, title, window_start, window_end, created_at from investigations order by created_at desc limit 50`,
      ), 'readonly');

    return (
      <>
        <PageHeader
          title="Investigations"
          description="Pick a metric to investigate a change, or open a saved investigation. An investigation decomposes a measured delta into the slices that account for it, then reports which related metrics moved alongside."
        />

        <Card className="mb-6">
          <CardHeader><CardTitle>Start an investigation</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {['pr_cycle_time', 'time_to_first_review', 'build_success_rate', 'build_duration', 'ci_queue_time', 'deployment_frequency', 'lead_time_for_changes', 'failed_deployment_rate'].map((m) => (
              <Link
                key={m}
                href={`/investigations?metric=${m}&period=${filters.period}`}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                {requireMetricDefinition(m).name}
              </Link>
            ))}
          </CardContent>
        </Card>

        {saved.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Saved investigations</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <thead><tr><Th>Title</Th><Th>Metric</Th><Th>Period</Th><Th className="text-right">Created</Th><Th /></tr></thead>
                <tbody>
                  {saved.map((s) => (
                    <tr key={s.id}>
                      <Td>{s.title}</Td>
                      <Td className="text-slate-400">{requireMetricDefinition(s.metric).name}</Td>
                      <Td className="font-mono text-[11px] text-slate-500">
                        {new Date(s.window_start).toISOString().slice(0, 10)} → {new Date(s.window_end).toISOString().slice(0, 10)}
                      </Td>
                      <Td className="text-right font-mono text-[11px] text-slate-500">{new Date(s.created_at).toISOString().slice(0, 16).replace('T', ' ')}</Td>
                      <Td className="text-right">
                        <Link href={`/investigations/${s.id}`} className="text-xs text-sky-400 hover:underline">Open</Link>
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

  const report = await runtime.investigator.investigate({
    orgId: session.orgId, metric, scopeType, scopeId, window: filters.window,
  });
  const series = await loadSeries(session.orgId, metric, filters, { scopeType, scopeId });
  const def = requireMetricDefinition(metric);

  return (
    <>
      <PageHeader
        title={report.title}
        description={report.headline}
        window={`${describeWindow(report.window)} vs ${describeWindow(report.baselineWindow)}`}
        right={
          <Link
            href={`/api/v1/export/investigations/${report.id}?format=markdown`}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            Export
          </Link>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Current" value={formatMetric(metric, report.current.result)} hint={`${report.current.result.sampleSize} observations`} />
        <Stat label="Baseline" value={formatMetric(metric, report.baseline.result)} hint={`${report.baseline.result.sampleSize} observations`} />
        <Stat
          label="Change"
          value={report.comparison.relativeChange === null ? INSUFFICIENT_DATA_LABEL : `${report.comparison.relativeChange >= 0 ? '+' : ''}${(report.comparison.relativeChange * 100).toFixed(1)}%`}
        />
        <Stat label="Baseline window" value={describeWindow(previousWindow(filters.window))} hint="equal length, immediately prior" />
      </div>

      <Card className="mb-6">
        <CardHeader><CardTitle>{def.name} over time</CardTitle></CardHeader>
        <CardContent><TrendChart points={series} unitLabel={def.unit} /></CardContent>
      </Card>

      {report.decomposedOnMean && (
        <Card className="mb-6 border-sky-900/60 bg-sky-950/20">
          <CardContent className="text-xs leading-relaxed text-sky-200">
            The headline figure is a <strong>median</strong>, which cannot be decomposed exactly. The contribution figures below
            decompose the <strong>mean</strong> of the same observations — they explain the same underlying movement, but the shares
            do not sum to the median delta.
          </CardContent>
        </Card>
      )}

      {report.dimensions.map((dim) => (
        <Card key={dim.dimension} className="mb-6">
          <CardHeader>
            <CardTitle>What accounts for the change, by {dim.dimension}</CardTitle>
            <p className="text-xs text-slate-500">
              Exact arithmetic decomposition. <strong>Own change</strong> is the slice&rsquo;s own values moving;{' '}
              <strong>volume shift</strong> is its share of the total moving. Residual: {dim.residual.toFixed(6)}.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>{dim.dimension}</Th><Th className="text-right">Current</Th><Th className="text-right">Baseline</Th>
                  <Th className="text-right">Share of change</Th><Th className="text-right">Own change</Th>
                  <Th className="text-right">Volume shift</Th><Th className="text-right">Observations</Th>
                </tr>
              </thead>
              <tbody>
                {dim.contributors.map((c) => (
                  <tr key={c.key}>
                    <Td className="max-w-56 truncate">{c.label}</Td>
                    <Td className="text-right tabular-nums">{c.currentValue === null ? <span className="text-slate-600">—</span> : c.currentValue.toFixed(2)}</Td>
                    <Td className="text-right tabular-nums">{c.baselineValue === null ? <span className="text-slate-600">—</span> : c.baselineValue.toFixed(2)}</Td>
                    <Td className={`text-right tabular-nums font-medium ${c.contributionShare > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                      {(c.contributionShare * 100).toFixed(1)}%
                    </Td>
                    <Td className="text-right tabular-nums text-slate-400">{c.rateEffect.toFixed(2)}</Td>
                    <Td className="text-right tabular-nums text-slate-400">{c.mixEffect.toFixed(2)}</Td>
                    <Td className="text-right tabular-nums text-slate-500">{c.sampleSize} / {c.baselineSampleSize}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="border-t border-slate-800 px-5 py-3">
              <ul className="space-y-1 text-xs text-slate-400">
                {dim.contributors.slice(0, 4).map((c) => <li key={c.key}>{c.statement}</li>)}
              </ul>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Associated metrics</CardTitle>
          <p className="text-xs text-slate-500">
            Examined over the same period. These are <strong>associations</strong>, not causes — correlation here is a reason to go
            and ask the team, not a conclusion. Candidates that did not move are listed too.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <thead>
              <tr><Th>Metric</Th><Th className="text-right">Current</Th><Th className="text-right">Baseline</Th><Th className="text-right">Change</Th><Th>Correlation</Th></tr>
            </thead>
            <tbody>
              {report.related.map((r) => (
                <tr key={r.metric} className={r.moved ? '' : 'opacity-60'}>
                  <Td><Link href={`/metrics/${r.metric}`} className="hover:text-sky-400">{r.name}</Link></Td>
                  <Td className="text-right tabular-nums">{r.currentLabel}</Td>
                  <Td className="text-right tabular-nums text-slate-400">{r.baselineLabel}</Td>
                  <Td className="text-right tabular-nums">
                    {r.comparison.relativeChange === null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <span className={r.moved ? 'text-slate-200' : 'text-slate-500'}>
                        {r.comparison.relativeChange >= 0 ? '+' : ''}{(r.comparison.relativeChange * 100).toFixed(1)}%
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={r.strength === 'strong' ? 'info' : r.strength === 'moderate' ? 'neutral' : 'muted'}>
                      {r.correlation === null ? 'unavailable' : `${r.strength} (r = ${r.correlation.toFixed(2)})`}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="border-t border-slate-800 px-5 py-3">
            <ul className="space-y-1 text-xs text-slate-400">
              {report.related.map((r) => <li key={r.metric}>{r.statement}</li>)}
            </ul>
          </div>
        </CardContent>
      </Card>

      {report.evidence.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Records examined</CardTitle>
            <p className="text-xs text-slate-500">The slowest pull requests in the affected repositories. Drill all the way down.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>Pull request</Th><Th>Author</Th><Th className="text-right">Lines</Th><Th className="text-right">Cycle time</Th><Th /></tr></thead>
              <tbody>
                {report.evidence.map((e) => (
                  <tr key={e.id}>
                    <Td className="max-w-md truncate">{e.label}</Td>
                    <Td className="text-slate-400">{String(e.detail.author ?? '—')}</Td>
                    <Td className="text-right tabular-nums">{String(e.detail.linesChanged ?? '—')}</Td>
                    <Td className="text-right tabular-nums">{e.detail.cycleTimeHours === null ? '—' : `${e.detail.cycleTimeHours} h`}</Td>
                    <Td className="text-right"><Link href={e.url} className="text-xs text-sky-400 hover:underline">Open</Link></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>How to read this</CardTitle></CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-slate-400">
            {report.caveats.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
        <span className="text-sm font-semibold text-slate-100">{value}</span>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </CardContent>
    </Card>
  );
}
