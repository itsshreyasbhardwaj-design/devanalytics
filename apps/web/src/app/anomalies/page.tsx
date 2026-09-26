import Link from 'next/link';
import { listAnomalies } from '@devanalytics/api';
import { formatValue, requireMetricDefinition } from '@devanalytics/metrics';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';

export const dynamic = 'force-dynamic';

export default async function AnomaliesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const sp = await searchParams;
  const filters = readFilters(sp);
  const status = typeof sp.status === 'string' ? sp.status : undefined;
  const runtime = await getRuntime();

  const anomalies = (await listAnomalies(runtime.db, session.orgId, {
    ...(status ? { status } : {}),
    limit: 100,
  })) as Record<string, unknown>[];

  return (
    <>
      <PageHeader
        title="Anomalies"
        description="Movements that are unusual against each scope's own history. There are no fixed thresholds: the baseline is the median and median absolute deviation of that scope's prior periods, and rate metrics are tested as proportions so a thin day is not mistaken for a trend."
        right={
          <div className="flex gap-1">
            {['all', 'open', 'acknowledged'].map((s) => (
              <Link
                key={s}
                href={`/anomalies?period=${filters.period}${s === 'all' ? '' : `&status=${s}`}`}
                className={`rounded-md border px-2 py-1 text-xs ${(status ?? 'all') === s ? 'border-sky-600 bg-sky-950/60 text-sky-300' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
              >
                {s}
              </Link>
            ))}
          </div>
        }
      />

      {anomalies.length === 0 ? (
        <EmptyState
          title="Nothing unusual detected"
          description="Detection needs at least 14 prior periods of history for a scope before it will judge a metric, and requires both statistical significance and a movement of at least 15% before raising an anomaly. An empty list here means the checks ran and found nothing, not that nothing was checked."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Metric</Th><Th>Scope</Th><Th>Period</Th>
                  <Th className="text-right">Observed</Th><Th className="text-right">Baseline</Th>
                  <Th className="text-right">Score</Th><Th>Severity</Th><Th>Confidence</Th>
                  <Th className="text-right">Observations</Th><Th />
                </tr>
              </thead>
              <tbody>
                {anomalies.map((a) => {
                  const metric = String(a.metric);
                  const def = requireMetricDefinition(metric);
                  const observed = Number(a.observed_value);
                  const baseline = Number(a.baseline_value);
                  const worse = def.direction === 'lower_is_better' ? observed > baseline : def.direction === 'higher_is_better' ? observed < baseline : false;
                  return (
                    <tr key={String(a.id)} id={String(a.id)} className="hover:bg-slate-900/50">
                      <Td><Link href={`/metrics/${metric}`} className="hover:text-sky-400">{def.name}</Link></Td>
                      <Td className="max-w-48 truncate text-slate-400">{String(a.scope_label)}</Td>
                      <Td className="font-mono text-[11px] text-slate-400">
                        {new Date(String(a.window_start)).toISOString().slice(0, 10)}
                      </Td>
                      <Td className={`text-right tabular-nums ${worse ? 'text-rose-400' : 'text-emerald-400'}`}>{formatValue(metric, observed)}</Td>
                      <Td className="text-right tabular-nums text-slate-400">{formatValue(metric, baseline)}</Td>
                      <Td className="text-right tabular-nums">{Number(a.score).toFixed(1)}</Td>
                      <Td><Badge tone={a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'warn' : 'neutral'}>{String(a.severity)}</Badge></Td>
                      <Td><Badge tone={a.confidence === 'high' ? 'info' : 'muted'}>{String(a.confidence)}</Badge></Td>
                      <Td className="text-right tabular-nums text-slate-400">
                        {String(a.sample_size)}
                        <span className="text-slate-700"> / {String(a.baseline_sample_size)}</span>
                      </Td>
                      <Td className="text-right">
                        <Link
                          href={`/investigations?metric=${metric}&scopeType=${String(a.scope_type)}&scopeId=${String(a.scope_id)}&anomalyId=${String(a.id)}&period=${filters.period}`}
                          className="text-xs text-sky-400 hover:underline"
                        >
                          Investigate
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader><CardTitle>How to read these columns</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-xs leading-relaxed text-slate-400 sm:grid-cols-2">
          <p><strong className="text-slate-300">Score</strong> is a modified z-score: how many robust standard deviations the observed value sits from the scope&rsquo;s historical median. For rate metrics it is a two-proportion z statistic instead, which accounts for how many runs there were.</p>
          <p><strong className="text-slate-300">Severity</strong> is about size — how far the value moved. <strong className="text-slate-300">Confidence</strong> is about evidence — how much history and how many observations were available. A high-severity, low-confidence row is worth a look, not an action.</p>
          <p><strong className="text-slate-300">Observations</strong> shows the count in the flagged period, then the count across the whole baseline. A small first number means treat the whole row sceptically.</p>
          <p><strong className="text-slate-300">Baseline</strong> is the median of prior periods for this exact scope, not a target and not a cross-organization comparison.</p>
        </CardContent>
      </Card>
    </>
  );
}
