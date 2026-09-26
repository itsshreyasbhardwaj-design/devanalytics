import {
  compare,
  previousWindow,
  stableId,
  type Comparison,
  type Granularity,
  type ScopeType,
  type TimeWindow,
} from '@devanalytics/core';
import type { Database } from '@devanalytics/db';
import { scopeLabel } from '@devanalytics/db';
import {
  MetricEngine,
  formatMetric,
  isAggregatable,
  requireMetricDefinition,
  supportsDimension,
  type Dimension,
  type MetricValue,
} from '@devanalytics/metrics';
import {
  ASSOCIATION_PHRASES,
  assertNonCausal,
  correlation,
  correlationStrength,
  decompose,
  type Contribution,
  type GroupStats,
} from './contribution.js';
import { relatedMetrics } from './related.js';

/**
 * Root-cause investigation.
 *
 * Given a metric that moved, this assembles the evidence a human needs to
 * decide what happened:
 *
 *   1. what moved, by how much, over which windows, on how many observations
 *   2. which slices of the organization account for the movement, arithmetically
 *   3. which related metrics moved with it, labelled as associations
 *   4. the individual records behind the largest contributors
 *
 * It does not conclude. Step 2 is exact arithmetic and is stated as such;
 * step 3 is correlational and is worded as such; the causal step is left to
 * the person who can go and ask the team.
 */

const DIMENSIONS: Dimension[] = ['repository', 'team', 'branch', 'author'];

export interface InvestigationRequest {
  orgId: string;
  metric: string;
  scopeType: ScopeType;
  scopeId: string;
  window: TimeWindow;
  /** Defaults to the window of equal length immediately before `window`. */
  baselineWindow?: TimeWindow;
  anomalyId?: string | null;
  granularity?: Granularity;
  maxContributorsPerDimension?: number;
}

export interface DimensionFinding {
  dimension: Dimension;
  /** Exact arithmetic decomposition; residual is reported so it can be checked. */
  residual: number;
  contributors: (Contribution & { statement: string })[];
}

export interface RelatedFinding {
  metric: string;
  name: string;
  comparison: Comparison;
  currentLabel: string;
  baselineLabel: string;
  /** Pearson correlation of the two metrics' bucketed series over the window. Null when unavailable. */
  correlation: number | null;
  strength: 'negligible' | 'weak' | 'moderate' | 'strong' | 'unavailable';
  statement: string;
  moved: boolean;
}

export interface EvidenceRecord {
  kind: 'pull_request' | 'workflow_run' | 'deployment';
  id: string;
  label: string;
  url: string;
  detail: Record<string, string | number | null>;
}

export interface InvestigationReport {
  id: string;
  orgId: string;
  title: string;
  metric: string;
  metricName: string;
  scopeType: ScopeType;
  scopeId: string;
  scopeLabel: string;
  window: TimeWindow;
  baselineWindow: TimeWindow;
  current: MetricValue;
  baseline: MetricValue;
  comparison: Comparison;
  /** True when the headline metric is a median, whose delta cannot be decomposed exactly. */
  decomposedOnMean: boolean;
  headline: string;
  dimensions: DimensionFinding[];
  related: RelatedFinding[];
  evidence: EvidenceRecord[];
  caveats: string[];
}

export class Investigator {
  constructor(
    private readonly db: Database,
    private readonly engine: MetricEngine,
  ) {}

  async investigate(req: InvestigationRequest): Promise<InvestigationReport> {
    const def = requireMetricDefinition(req.metric);
    const baselineWindow = req.baselineWindow ?? previousWindow(req.window);
    const granularity = req.granularity ?? 'day';
    const maxContributors = req.maxContributorsPerDimension ?? 8;

    const base = {
      orgId: req.orgId, metric: req.metric, scopeType: req.scopeType, scopeId: req.scopeId,
    };
    const [current, baseline] = await Promise.all([
      this.engine.value({ ...base, window: req.window }),
      this.engine.value({ ...base, window: baselineWindow }),
    ]);
    const comparison = compare(current.result, baseline.result);

    const label = await this.db.withOrg(req.orgId, (sql) => scopeLabel(sql, req.scopeType, req.scopeId), 'readonly');

    const dimensions = await this.decomposeAll(req, baselineWindow, maxContributors);
    const related = await this.examineRelated(req, baselineWindow, granularity);
    const evidence = await this.collectEvidence(req, dimensions);

    const headline = assertNonCausal(buildHeadline(def.name, label, current, baseline, comparison));

    return {
      id: stableId('investigation', req.orgId, req.metric, req.scopeId, req.window.from, req.window.to),
      orgId: req.orgId,
      title: `${def.name} — ${label}`,
      metric: req.metric,
      metricName: def.name,
      scopeType: req.scopeType,
      scopeId: req.scopeId,
      scopeLabel: label,
      window: req.window,
      baselineWindow,
      current,
      baseline,
      comparison,
      decomposedOnMean: !isAggregatable(def),
      headline,
      dimensions,
      related,
      evidence,
      caveats: [
        ...def.caveats,
        ...(isAggregatable(def)
          ? []
          : [
              `${def.name} is reported as a median, which cannot be decomposed exactly. The contribution figures below decompose the mean of the same observations, so they explain the same underlying movement but not the same headline number.`,
            ]),
        'Contributions are arithmetic shares of the measured change. Related metrics are associations observed over the same period, not causes.',
      ],
    };
  }

  private async decomposeAll(req: InvestigationRequest, baselineWindow: TimeWindow, limit: number): Promise<DimensionFinding[]> {
    const out: DimensionFinding[] = [];
    for (const dimension of DIMENSIONS) {
      if (!supportsDimension(req.metric, dimension)) continue;
      const base = { orgId: req.orgId, metric: req.metric, scopeType: req.scopeType, scopeId: req.scopeId };
      const [cur, prev] = await Promise.all([
        this.engine.breakdown({ ...base, window: req.window }, dimension, 200),
        this.engine.breakdown({ ...base, window: baselineWindow }, dimension, 200),
      ]);
      if (cur.length === 0 && prev.length === 0) continue;

      const toStats = (rows: typeof cur): GroupStats[] =>
        rows
          .filter((r) => (r.denominator ?? 0) > 0)
          .map((r) => ({
            key: r.key, label: r.label,
            numerator: r.numerator ?? 0, denominator: r.denominator ?? 0,
            sampleSize: r.result.sampleSize,
          }));

      const d = decompose(toStats(cur), toStats(prev));
      if (d.delta === null) continue;

      const contributors = d.contributions.slice(0, limit).map((c) => ({
        ...c,
        statement: assertNonCausal(describeContribution(req.metric, c, d.delta as number)),
      }));
      out.push({ dimension, residual: d.residual, contributors });
    }
    return out;
  }

  private async examineRelated(req: InvestigationRequest, baselineWindow: TimeWindow, granularity: Granularity): Promise<RelatedFinding[]> {
    const primarySeries = await this.engine.series({
      orgId: req.orgId, metric: req.metric, scopeType: req.scopeType, scopeId: req.scopeId,
      window: { from: baselineWindow.from, to: req.window.to }, granularity,
    });

    const findings: RelatedFinding[] = [];
    for (const metric of relatedMetrics(req.metric)) {
      const def = requireMetricDefinition(metric);
      if (!def.supportedScopes.includes(req.scopeType)) continue;
      const base = { orgId: req.orgId, metric, scopeType: req.scopeType, scopeId: req.scopeId };
      const [cur, prev, series] = await Promise.all([
        this.engine.value({ ...base, window: req.window }),
        this.engine.value({ ...base, window: baselineWindow }),
        this.engine.series({ ...base, window: { from: baselineWindow.from, to: req.window.to }, granularity }),
      ]);
      const cmp = compare(cur.result, prev.result);

      // Correlate only on buckets where both metrics actually have a value.
      const byBucket = new Map(series.map((p) => [p.bucketStart, p]));
      const xs: number[] = [];
      const ys: number[] = [];
      for (const p of primarySeries) {
        const other = byBucket.get(p.bucketStart);
        if (p.result.status === 'ok' && other && other.result.status === 'ok') {
          xs.push(p.result.value);
          ys.push(other.result.value);
        }
      }
      const r = correlation(xs, ys);
      const strength = r === null ? ('unavailable' as const) : correlationStrength(r);
      const moved = cmp.relativeChange !== null && Math.abs(cmp.relativeChange) >= 0.1;

      findings.push({
        metric,
        name: def.name,
        comparison: cmp,
        currentLabel: formatMetric(metric, cur.result),
        baselineLabel: formatMetric(metric, prev.result),
        correlation: r,
        strength,
        moved,
        statement: assertNonCausal(describeRelated(def.name, cmp, r, strength, xs.length)),
      });
    }
    // Biggest movers first; unchanged candidates are kept and reported as unchanged.
    findings.sort((a, b) => Math.abs(b.comparison.relativeChange ?? 0) - Math.abs(a.comparison.relativeChange ?? 0));
    return findings;
  }

  private async collectEvidence(req: InvestigationRequest, dimensions: DimensionFinding[]): Promise<EvidenceRecord[]> {
    const repoFinding = dimensions.find((d) => d.dimension === 'repository');
    const topRepoKeys = (repoFinding?.contributors ?? []).filter((c) => c.contribution > 0).slice(0, 3).map((c) => c.key);

    return this.db.withOrg(req.orgId, async (sql) => {
      const params: (string | number)[] = [req.window.from, req.window.to];
      let repoClause = '';
      if (topRepoKeys.length > 0) {
        params.push(topRepoKeys as unknown as string);
        repoClause = `and p.repo_id = any($${params.length}::text[])`;
      }
      const rows = await sql.many<{
        id: string; number: number; title: string; full_name: string; login: string | null;
        ready_for_review_at: Date | null; first_review_at: Date | null; merged_at: Date | null;
        additions: number; deletions: number; hours: number | null;
      }>(
        `select p.id, p.number, p.title, r.full_name, u.login,
                p.ready_for_review_at, p.first_review_at, p.merged_at, p.additions, p.deletions,
                extract(epoch from (p.merged_at - p.ready_for_review_at)) / 3600.0 as hours
           from pull_requests p
           join repositories r on r.id = p.repo_id
           left join users u on u.id = p.author_user_id
          where p.merged_at >= $1::timestamptz and p.merged_at < $2::timestamptz
            and p.ready_for_review_at is not null
            and coalesce(u.is_bot, false) = false
            ${repoClause}
          order by hours desc nulls last
          limit 10`,
        params,
      );
      return rows.map<EvidenceRecord>((r) => ({
        kind: 'pull_request',
        id: r.id,
        label: `${r.full_name}#${r.number} — ${r.title}`,
        url: `/pull-requests/${r.id}`,
        detail: {
          repository: r.full_name,
          author: r.login,
          linesChanged: r.additions + r.deletions,
          cycleTimeHours: r.hours === null ? null : Number(Number(r.hours).toFixed(2)),
          readyForReviewAt: r.ready_for_review_at ? new Date(r.ready_for_review_at).toISOString() : null,
          firstReviewAt: r.first_review_at ? new Date(r.first_review_at).toISOString() : null,
          mergedAt: r.merged_at ? new Date(r.merged_at).toISOString() : null,
        },
      }));
    }, 'readonly');
  }

  /** Persist a report so it can be linked to, revisited and cited. */
  async save(report: InvestigationReport, createdBy: string | null, anomalyId: string | null = null): Promise<string> {
    await this.db.withOrg(report.orgId, async (sql) => {
      await sql.query(
        `insert into investigations (id, org_id, anomaly_id, metric, scope_type, scope_id, window_start, window_end, baseline_start, baseline_end, title, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do update set title = excluded.title`,
        [report.id, sql.orgId, anomalyId, report.metric, report.scopeType, report.scopeId,
         report.window.from, report.window.to, report.baselineWindow.from, report.baselineWindow.to,
         report.title, createdBy],
      );
      await sql.query(`delete from investigation_findings where investigation_id = $1`, [report.id]);
      let rank = 0;
      for (const dim of report.dimensions) {
        for (const c of dim.contributors) {
          await sql.query(
            `insert into investigation_findings
               (id, org_id, investigation_id, dimension, dimension_value, label, current_value, baseline_value,
                contribution, contribution_share, sample_size, baseline_sample_size, evidence, rank)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              stableId('finding', report.id, dim.dimension, c.key), sql.orgId, report.id,
              dim.dimension, c.key, c.label, c.currentValue, c.baselineValue,
              c.contribution, c.contributionShare, c.sampleSize, c.baselineSampleSize,
              JSON.stringify({ rateEffect: c.rateEffect, mixEffect: c.mixEffect, statement: c.statement }),
              rank++,
            ],
          );
        }
      }
    });
    return report.id;
  }
}

function buildHeadline(metricName: string, scope: string, current: MetricValue, baseline: MetricValue, cmp: Comparison): string {
  if (current.result.status !== 'ok') {
    return `${metricName} for ${scope} cannot be reported for this period: ${describeInsufficient(current)}.`;
  }
  if (baseline.result.status !== 'ok') {
    return `${metricName} for ${scope} is ${formatMetric(current.metric, current.result)} across ${current.result.sampleSize} observations. There is no comparable baseline period, so no change can be reported.`;
  }
  const pct = cmp.relativeChange === null ? null : `${cmp.relativeChange >= 0 ? '+' : ''}${(cmp.relativeChange * 100).toFixed(1)}%`;
  const movement = pct ? `${pct} versus ${formatMetric(baseline.metric, baseline.result)}` : `versus ${formatMetric(baseline.metric, baseline.result)}`;
  return `${metricName} for ${scope} is ${formatMetric(current.metric, current.result)} (${movement}), based on ${current.result.sampleSize} observations against ${baseline.result.sampleSize} in the baseline period.`;
}

function describeInsufficient(v: MetricValue): string {
  if (v.result.status === 'ok') return '';
  return v.result.reason === 'metric_not_supported_for_scope'
    ? 'this metric is not defined for this scope'
    : `${v.result.sampleSize} observations, ${v.result.minimumSampleSize} required`;
}

function describeContribution(metric: string, c: Contribution, delta: number): string {
  const share = delta === 0 ? 0 : (c.contribution / delta) * 100;
  const pct = `${share >= 0 ? '' : '-'}${Math.abs(share).toFixed(1)}%`;
  const parts = [ASSOCIATION_PHRASES.contribution(c.label, pct)];

  const rateShare = Math.abs(c.rateEffect);
  const mixShare = Math.abs(c.mixEffect);
  if (rateShare > mixShare * 2) {
    parts.push('driven by its own values changing rather than by its share of volume');
  } else if (mixShare > rateShare * 2) {
    parts.push(
      `driven by its share of volume moving from ${(c.baselineWeight * 100).toFixed(0)}% to ${(c.currentWeight * 100).toFixed(0)}% rather than by its own values changing`,
    );
  }
  if (c.sampleSize < 5) parts.push(`based on only ${c.sampleSize} observations`);
  void metric;
  return `${parts.join(', ')}.`;
}

function describeRelated(
  name: string,
  cmp: Comparison,
  r: number | null,
  strength: string,
  pairedBuckets: number,
): string {
  if (cmp.relativeChange === null) {
    return `${name} has no comparable value across the two periods, so no association can be assessed.`;
  }
  const pct = `${cmp.relativeChange >= 0 ? '+' : ''}${(cmp.relativeChange * 100).toFixed(1)}%`;
  if (Math.abs(cmp.relativeChange) < 0.1) {
    return `${name} was effectively unchanged (${pct}) over the same period.`;
  }
  if (r === null || strength === 'negligible' || strength === 'unavailable') {
    return `${name} moved ${pct} over the same period, with no usable correlation across the ${pairedBuckets} comparable buckets.`;
  }
  return `${name} moved ${pct} over the same period and ${ASSOCIATION_PHRASES.correlation('it', strength)} (r = ${r.toFixed(2)} across ${pairedBuckets} buckets).`;
}
