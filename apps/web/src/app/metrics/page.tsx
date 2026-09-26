import Link from 'next/link';
import { METRIC_DEFINITIONS, METRIC_IDS, isAggregatable } from '@devanalytics/metrics';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';

export const dynamic = 'force-dynamic';

/**
 * The metric catalogue.
 *
 * Every metric's definition, formula, source tables, time anchor, minimum
 * sample size and caveats, rendered from the same registry the engine computes
 * from. If a number appears anywhere in this product, its contract is here.
 */
export default function MetricsPage() {
  return (
    <>
      <PageHeader
        title="Metrics"
        description="Every metric this platform computes, with its exact formula, source tables, time anchor and the assumptions you need to know before you act on it. This page is generated from the same registry the engine uses."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {METRIC_IDS.map((id) => {
          const def = METRIC_DEFINITIONS[id];
          if (!def) return null;
          return (
            <Card key={id} id={id}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>
                    <Link href={`/metrics/${id}`} className="hover:text-sky-400">{def.name}</Link>
                  </CardTitle>
                  <Badge tone="muted">{def.unit}</Badge>
                  <Badge tone={def.direction === 'lower_is_better' ? 'info' : def.direction === 'higher_is_better' ? 'good' : 'neutral'}>
                    {def.direction.replace(/_/g, ' ')}
                  </Badge>
                  {!isAggregatable(def) && <Badge tone="warn">not aggregatable</Badge>}
                </div>
                <p className="text-xs leading-relaxed text-slate-400">{def.description}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-xs">
                <Field label="Formula"><code className="text-slate-300">{def.formula}</code></Field>
                <Field label="Data source"><code className="text-slate-300">{def.dataSource.join(', ')}</code></Field>
                <Field label="Time anchor"><code className="text-slate-300">{def.timeAnchor}</code></Field>
                <Field label="Minimum sample">
                  <span className="text-slate-300">
                    {def.minimumSampleSize} observations. Below this, the value is reported as &ldquo;Insufficient data&rdquo;.
                  </span>
                </Field>
                <Field label="Scopes"><span className="text-slate-300">{def.supportedScopes.join(', ')}</span></Field>
                <Field label="Filters"><span className="text-slate-300">{def.appliedFilters.join(', ')}</span></Field>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Caveats</p>
                  <ul className="list-disc space-y-1 pl-4 text-slate-400">
                    {def.caveats.map((c) => <li key={c}>{c}</li>)}
                  </ul>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      {children}
    </div>
  );
}
