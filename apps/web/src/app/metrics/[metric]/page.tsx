import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMetricDefinition, formatMetric, isAggregatable, supportsDimension, type Dimension } from '@devanalytics/metrics';
import { INSUFFICIENT_DATA_LABEL } from '@devanalytics/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@devanalytics/ui';
import { MetricTile } from '@/components/metric-tile';
import { TrendChart } from '@/components/trend-chart';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, filtersToQuery, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetric, loadSeries, scopeFor } from '@/lib/data';
import { toAnalyticsFilters } from '@/lib/filters';

export const dynamic = 'force-dynamic';

const DIMENSIONS: Dimension[] = ['repository', 'team', 'branch', 'author'];

export default async function MetricPage({
  params,
  searchParams,
}: {
  params: Promise<{ metric: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { metric } = await params;
  const def = getMetricDefinition(metric);
  if (!def) notFound();

  const session = await getSession();
  if (session.empty) notFound();

  const filters = readFilters(await searchParams);
  const scope = scopeFor(session.orgId, filters);
  const runtime = await getRuntime();

  const loaded = await loadMetric(session.orgId, metric, filters, scope);
  const series = await loadSeries(session.orgId, metric, filters, scope);

  const breakdowns: { dimension: Dimension; rows: Awaited<ReturnType<typeof runtime.engine.breakdown>> }[] = [];
  for (const dimension of DIMENSIONS) {
    if (!supportsDimension(metric, dimension)) continue;
    const rows = await runtime.engine.breakdown(
      { orgId: session.orgId, metric, scopeType: scope.scopeType, scopeId: scope.scopeId, window: filters.window, filters: toAnalyticsFilters(filters) },
      dimension,
      12,
    );
    if (rows.length > 0) breakdowns.push({ dimension, rows });
  }

  const facts = await runtime.engine.facts(
    { orgId: session.orgId, metric, scopeType: scope.scopeType, scopeId: scope.scopeId, window: filters.window, filters: toAnalyticsFilters(filters) },
    15,
  );

  const query = filtersToQuery(filters);

  return (
    <>
      <PageHeader
        title={def.name}
        description={def.description}
        window={describeWindow(filters.window)}
        right={
          <div className="flex items-center gap-2">
            <Link href={`/api/v1/export/metrics/${metric}${query}`} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
              Export CSV
            </Link>
            <Link href={`/investigations${query}${query ? '&' : '?'}metric=${metric}`} className="rounded-md bg-sky-500 px-2 py-1 text-xs font-medium text-slate-950 hover:bg-sky-400">
              Investigate
            </Link>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile metric={metric} result={loaded.value.result} comparison={loaded.comparison} />
        <Card>
          <CardContent className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Previous period</span>
            <span className="text-lg font-semibold text-slate-200">{formatMetric(metric, loaded.comparison.previous)}</span>
            <span className="text-[11px] text-slate-400">{loaded.comparison.previous.sampleSize} observations</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Absolute change</span>
            <span className="text-lg font-semibold text-slate-200">
              {loaded.comparison.absoluteChange === null ? INSUFFICIENT_DATA_LABEL : loaded.comparison.absoluteChange.toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-400">{def.unit}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-slate-400">Aggregation</span>
            <span className="text-lg font-semibold text-slate-200">{def.aggregation}</span>
            <span className="text-[11px] text-slate-400">
              {isAggregatable(def) ? 'Rebuilt from daily snapshots' : 'Recomputed from records; a median of medians would be wrong'}
            </span>
          </CardContent>
        </Card>
      </div>

      {loaded.value.excluded && (
        <Card className="mb-6 border-amber-900/60 bg-amber-950/20">
          <CardContent className="text-xs text-amber-200">
            <strong>{loaded.value.excluded.count} records excluded.</strong> {loaded.value.excluded.reason}
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>History</CardTitle>
          <p className="text-xs text-slate-400">
            Bucketed by {filters.granularity}. Anchored on <code>{def.timeAnchor}</code>.
          </p>
        </CardHeader>
        <CardContent>
          <TrendChart points={series} unitLabel={def.unit} height={260} />
        </CardContent>
      </Card>

      {breakdowns.map(({ dimension, rows }) => (
        <Card key={dimension} className="mb-6">
          <CardHeader>
            <CardTitle>By {dimension}</CardTitle>
            <p className="text-xs text-slate-400">
              Slices of the same window. To attribute a <em>change</em> rather than compare levels, run an investigation.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>{dimension}</Th>
                  <Th className="text-right">Value</Th>
                  <Th className="text-right">Observations</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <Td className="max-w-xs truncate">{r.label}</Td>
                    <Td className="text-right tabular-nums">
                      {r.result.status === 'ok' ? formatMetric(metric, r.result) : <span className="text-slate-400">{INSUFFICIENT_DATA_LABEL}</span>}
                    </Td>
                    <Td className="text-right tabular-nums text-slate-400">{r.result.sampleSize}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Underlying observations</CardTitle>
          <p className="text-xs text-slate-400">
            The individual records this value is computed from — the end of every drill-down path.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {facts.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-slate-400">No observations in this window.</p>
          ) : (
            <Table>
              <thead>
                <tr><Th>Observed at</Th><Th className="text-right">Value ({def.unit})</Th></tr>
              </thead>
              <tbody>
                {facts.map((f, i) => (
                  <tr key={`${f.ts}-${i}`}>
                    <Td className="font-mono text-[11px]">{f.ts.replace('T', ' ').slice(0, 19)}</Td>
                    <Td className="text-right tabular-nums">{f.val === null ? '—' : f.val.toFixed(2)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 flex flex-wrap gap-2 text-[11px] text-slate-400">
        {def.caveats.map((c) => <Badge key={c} tone="muted" className="max-w-full whitespace-normal text-left">{c}</Badge>)}
      </div>
    </>
  );
}
