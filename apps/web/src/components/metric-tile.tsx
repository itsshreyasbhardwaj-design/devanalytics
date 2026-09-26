import Link from 'next/link';
import { INSUFFICIENT_DATA_LABEL, type Comparison, type MetricResult } from '@devanalytics/core';
import { changeSentiment, formatChange, formatMetric, requireMetricDefinition } from '@devanalytics/metrics';
import { Badge, cn } from '@devanalytics/ui';
import { ArrowDownRight, ArrowRight, ArrowUpRight, HelpCircle } from 'lucide-react';

/**
 * A single metric.
 *
 * Three rules this component exists to enforce:
 *   1. `insufficient_data` renders as the words, plus how many observations
 *      were found and how many were needed. It is never 0 and never a dash.
 *   2. Direction is judged against the metric's declared direction, so a rising
 *      deployment frequency is green and a rising cycle time is red.
 *   3. The sample size is always visible, because a 40% move on six pull
 *      requests is not the same claim as a 40% move on six hundred.
 */
export function MetricTile({
  metric,
  result,
  comparison,
  href,
  compact = false,
}: {
  metric: string;
  result: MetricResult;
  comparison?: Comparison | undefined;
  href?: string;
  compact?: boolean;
}) {
  const def = requireMetricDefinition(metric);
  const sentiment = changeSentiment(metric, comparison?.relativeChange ?? null);
  const relative = comparison?.relativeChange ?? null;
  const Arrow = relative === null ? ArrowRight : relative > 0 ? ArrowUpRight : relative < 0 ? ArrowDownRight : ArrowRight;

  const body = (
    <div className={cn('flex flex-col gap-1.5', compact ? 'p-3' : 'p-4')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{def.name}</span>
        <span title={`${def.formula}\n\nAnchored on ${def.timeAnchor}. Minimum sample: ${def.minimumSampleSize}.`}>
          <HelpCircle className="h-3.5 w-3.5 text-slate-600" aria-label={`${def.name} definition: ${def.formula}`} />
        </span>
      </div>

      {result.status === 'ok' ? (
        <div className="flex items-baseline gap-2">
          <span className={cn('font-semibold tabular-nums text-slate-50', compact ? 'text-xl' : 'text-2xl')}>
            {formatMetric(metric, result)}
          </span>
          {relative !== null && (
            <span
              className={cn(
                'flex items-center gap-0.5 text-xs font-medium tabular-nums',
                sentiment === 'good' ? 'text-emerald-400' : sentiment === 'bad' ? 'text-rose-400' : 'text-slate-400',
              )}
            >
              <Arrow className="h-3.5 w-3.5" aria-hidden />
              {formatChange(relative)}
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className={cn('font-medium text-slate-500', compact ? 'text-sm' : 'text-base')}>{INSUFFICIENT_DATA_LABEL}</span>
          <span className="text-[11px] text-slate-600">
            {result.reason === 'metric_not_supported_for_scope'
              ? 'Not defined for this scope'
              : `${result.sampleSize} of ${result.minimumSampleSize} observations needed`}
          </span>
        </div>
      )}

      {result.status === 'ok' && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span className="tabular-nums">{result.sampleSize.toLocaleString('en-US')} observations</span>
          {comparison && comparison.previous.status !== 'ok' && <Badge tone="muted">no baseline</Badge>}
        </div>
      )}
    </div>
  );

  const shell = cn(
    'rounded-xl border bg-slate-900/60 transition-colors',
    result.status === 'ok' ? 'border-slate-800' : 'border-slate-800/60 bg-slate-900/30',
    href && 'hover:border-slate-700 hover:bg-slate-900',
  );

  return href ? (
    <Link href={href} className={cn(shell, 'block focus-visible:border-sky-600')}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
