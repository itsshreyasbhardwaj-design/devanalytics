import { compare, previousWindow, type Comparison } from '@devanalytics/core';
import type { Database } from '@devanalytics/db';
import { MetricEngine, formatMetric, requireMetricDefinition } from '@devanalytics/metrics';
import { Investigator, type InvestigationReport } from '@devanalytics/investigations';
import type { AnalyticsPlan } from './planner.js';

/**
 * Evidence collection.
 *
 * Executing a plan produces a bundle of *citable facts*. Each citation names
 * the metric, the scope, the exact window and the number of records behind it,
 * and carries a link to the records themselves. The narration step downstream
 * is only allowed to restate what is in this bundle.
 *
 * This is the opposite of passing a database to a model. The model sees a few
 * dozen verified facts, and those facts are the same ones the dashboard shows.
 */

export interface Citation {
  id: string;
  kind: 'metric' | 'comparison' | 'contribution' | 'correlation' | 'record' | 'exclusion';
  metric: string | null;
  scope: string;
  window: { from: string; to: string };
  statement: string;
  /** Numeric values a narration may legitimately mention. */
  values: number[];
  sampleSize: number;
  href: string | null;
}

export interface EvidenceBundle {
  plan: AnalyticsPlan;
  /** True when no metric could be computed at all. */
  empty: boolean;
  citations: Citation[];
  investigation: InvestigationReport | null;
  series: { bucketStart: string; value: number | null; sampleSize: number }[];
  notes: string[];
}

/** The bucket count a correlation statement quotes, so it is citable. */
function extractBucketCount(statement: string): number[] {
  const m = /across (?:the )?(\d+)(?: comparable)? buckets/.exec(statement);
  return m?.[1] ? [Number(m[1])] : [];
}

export class EvidenceCollector {
  constructor(
    private readonly db: Database,
    private readonly engine: MetricEngine,
    private readonly investigator: Investigator,
  ) {}

  async collect(plan: AnalyticsPlan): Promise<EvidenceBundle> {
    const citations: Citation[] = [];
    const notes: string[] = [];
    let investigation: InvestigationReport | null = null;
    let series: EvidenceBundle['series'] = [];

    if (!plan.metric || plan.intent === 'unknown') {
      return {
        plan, empty: true, citations, investigation, series,
        notes: ['The question could not be mapped to a metric this platform computes.'],
      };
    }

    const def = requireMetricDefinition(plan.metric);
    const scopeId = plan.scopeId;
    if (!scopeId) {
      return { plan, empty: true, citations, investigation, series, notes: ['The question referred to a scope that could not be resolved.'] };
    }
    const req = { orgId: plan.orgId, metric: plan.metric, scopeType: plan.scopeType, scopeId, window: plan.window };
    const scopeLabel = plan.scopeHint ?? 'the organization';

    const current = await this.engine.value(req);
    const baselineWindow = previousWindow(plan.window);
    const baseline = await this.engine.value({ ...req, window: baselineWindow });
    const cmp: Comparison = compare(current.result, baseline.result);

    citations.push({
      id: `metric:${plan.metric}:current`,
      kind: 'metric',
      metric: plan.metric,
      scope: scopeLabel,
      window: plan.window,
      statement: `${def.name} for ${scopeLabel} is ${formatMetric(plan.metric, current.result)} over ${plan.window.from.slice(0, 10)} to ${plan.window.to.slice(0, 10)}, from ${current.result.sampleSize} observations.`,
      // The sample minimum is quoted whenever a value is withheld, so it has to
      // be citable too.
      values: current.result.status === 'ok'
        ? [current.result.value, current.result.sampleSize, def.minimumSampleSize]
        : [current.result.sampleSize, current.result.minimumSampleSize],
      sampleSize: current.result.sampleSize,
      href: `/metrics/${plan.metric}?scopeType=${plan.scopeType}&scopeId=${scopeId}`,
    });

    if (current.result.status !== 'ok') {
      notes.push(
        current.result.reason === 'metric_not_supported_for_scope'
          ? `${def.name} is not defined for a ${plan.scopeType} scope.`
          : `${def.name} has ${current.result.sampleSize} observations in this window; ${current.result.minimumSampleSize} are required before a value is reported.`,
      );
    }

    if (current.excluded) {
      citations.push({
        id: `exclusion:${plan.metric}`,
        kind: 'exclusion',
        metric: plan.metric,
        scope: scopeLabel,
        window: plan.window,
        statement: `${current.excluded.count} records were excluded from ${def.name}: ${current.excluded.reason}`,
        values: [current.excluded.count],
        sampleSize: current.excluded.count,
        href: null,
      });
    }

    if (baseline.result.status === 'ok' && current.result.status === 'ok') {
      citations.push({
        id: `comparison:${plan.metric}`,
        kind: 'comparison',
        metric: plan.metric,
        scope: scopeLabel,
        window: baselineWindow,
        statement: `The preceding equal-length period (${baselineWindow.from.slice(0, 10)} to ${baselineWindow.to.slice(0, 10)}) was ${formatMetric(plan.metric, baseline.result)} from ${baseline.result.sampleSize} observations, a change of ${cmp.relativeChange === null ? 'n/a' : `${(cmp.relativeChange * 100).toFixed(1)}%`}.`,
        values: [
          baseline.result.value,
          baseline.result.sampleSize,
          ...(cmp.relativeChange === null ? [] : [Number((cmp.relativeChange * 100).toFixed(1))]),
          ...(cmp.absoluteChange === null ? [] : [Number(cmp.absoluteChange.toFixed(2))]),
        ],
        sampleSize: baseline.result.sampleSize,
        href: null,
      });
    }

    if (plan.intent === 'metric_trend' || plan.intent === 'investigate') {
      const points = await this.engine.series({ ...req, granularity: plan.period === '1d' || plan.period === '7d' ? 'day' : 'week' });
      series = points.map((p) => ({
        bucketStart: p.bucketStart,
        value: p.result.status === 'ok' ? p.result.value : null,
        sampleSize: p.result.sampleSize,
      }));
    }

    if (plan.intent === 'investigate' || plan.intent === 'contributors') {
      investigation = await this.investigator.investigate({
        orgId: plan.orgId, metric: plan.metric, scopeType: plan.scopeType, scopeId,
        window: plan.window, baselineWindow,
      });

      const dimension = plan.dimension ?? 'repository';
      const finding = investigation.dimensions.find((d) => d.dimension === dimension) ?? investigation.dimensions[0];
      for (const c of finding?.contributors.slice(0, 5) ?? []) {
        citations.push({
          id: `contribution:${dimension}:${c.key}`,
          kind: 'contribution',
          metric: plan.metric,
          scope: c.label,
          window: plan.window,
          statement: c.statement,
          values: [
            Number((c.contributionShare * 100).toFixed(1)),
            ...(c.currentValue === null ? [] : [Number(c.currentValue.toFixed(2))]),
            ...(c.baselineValue === null ? [] : [Number(c.baselineValue.toFixed(2))]),
            c.sampleSize,
          ],
          sampleSize: c.sampleSize,
          href: dimension === 'repository' ? `/repositories/${c.key}` : null,
        });
      }

      for (const r of investigation.related) {
        citations.push({
          id: `correlation:${r.metric}`,
          kind: 'correlation',
          metric: r.metric,
          scope: scopeLabel,
          window: plan.window,
          statement: r.statement,
          values: [
            ...(r.comparison.relativeChange === null ? [] : [Number((r.comparison.relativeChange * 100).toFixed(1))]),
            ...(r.correlation === null ? [] : [Number(r.correlation.toFixed(2))]),
            // The statement quotes how many buckets the correlation used; that
            // figure has to be verifiable too.
            r.comparison.current.sampleSize,
            ...extractBucketCount(r.statement),
          ],
          sampleSize: r.comparison.current.sampleSize,
          href: `/metrics/${r.metric}`,
        });
      }

      for (const e of investigation.evidence.slice(0, 5)) {
        citations.push({
          id: `record:${e.id}`,
          kind: 'record',
          metric: plan.metric,
          scope: String(e.detail.repository ?? scopeLabel),
          window: plan.window,
          statement: `${e.label} took ${e.detail.cycleTimeHours ?? 'unknown'} hours with ${e.detail.linesChanged ?? 'unknown'} lines changed.`,
          values: [Number(e.detail.cycleTimeHours ?? 0), Number(e.detail.linesChanged ?? 0)],
          sampleSize: 1,
          href: e.url,
        });
      }
      notes.push(...investigation.caveats);
    }

    if (plan.intent === 'failure_patterns') {
      citations.push(...(await this.failurePatterns(plan)));
    }

    if (plan.intent === 'records') {
      citations.push(...(await this.records(plan)));
    }

    return { plan, empty: citations.length === 0, citations, investigation, series, notes };
  }

  /** Grouped characteristics of failing CI runs. Descriptive only. */
  private async failurePatterns(plan: AnalyticsPlan): Promise<Citation[]> {
    const orgId = plan.orgId;
    const rows = await this.db.withOrg(orgId, (sql) =>
      sql.many<{ workflow: string; repository: string; branch: string | null; failures: number; total: number; median_minutes: number | null }>(
        `select w.name as workflow, r.full_name as repository, wr.head_branch as branch,
                count(*) filter (where wr.conclusion = 'failure')::int as failures,
                count(*)::int as total,
                percentile_cont(0.5) within group (order by extract(epoch from (wr.completed_at - wr.started_at)) / 60.0) as median_minutes
           from workflow_runs wr
           join workflows w on w.id = wr.workflow_id
           join repositories r on r.id = wr.repo_id
          where wr.created_at >= $1::timestamptz and wr.created_at < $2::timestamptz
            and wr.conclusion in ('success','failure','timed_out')
          group by 1,2,3
         having count(*) filter (where wr.conclusion = 'failure') > 0
          order by failures desc
          limit 10`,
        [plan.window.from, plan.window.to],
      ), 'readonly');

    return rows.map((r) => ({
      id: `failure:${r.repository}:${r.workflow}:${r.branch ?? 'none'}`,
      kind: 'record' as const,
      metric: 'build_success_rate',
      scope: r.repository,
      window: plan.window,
      statement: `${r.workflow} on ${r.repository}${r.branch ? ` (${r.branch})` : ''} failed ${r.failures} of ${r.total} runs, a ${((r.failures / r.total) * 100).toFixed(1)}% failure rate, with a median duration of ${r.median_minutes === null ? 'unknown' : Number(r.median_minutes).toFixed(1)} minutes.`,
      values: [r.failures, r.total, Number(((r.failures / r.total) * 100).toFixed(1))],
      sampleSize: r.total,
      href: `/ci?repositoryId=${encodeURIComponent(r.repository)}`,
    }));
  }

  private async records(plan: AnalyticsPlan): Promise<Citation[]> {
    const facts = await this.engine.facts(
      { orgId: plan.orgId, metric: plan.metric as string, scopeType: plan.scopeType, scopeId: plan.scopeId as string, window: plan.window },
      10,
    );
    return facts
      .filter((f) => f.val !== null)
      .map((f, i) => ({
        id: `fact:${i}`,
        kind: 'record' as const,
        metric: plan.metric,
        scope: plan.scopeHint ?? 'the organization',
        window: plan.window,
        statement: `An observation on ${f.ts.slice(0, 10)} measured ${(f.val as number).toFixed(2)}.`,
        values: [Number((f.val as number).toFixed(2))],
        sampleSize: 1,
        href: null,
      }));
  }
}
