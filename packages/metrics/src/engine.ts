import {
  DEFAULT_FILTERS,
  MS_PER_DAY,
  compare,
  insufficient,
  ok,
  previousWindow,
  windowLengthMs,
  type AnalyticsFilters,
  type Comparison,
  type Granularity,
  type MetricResult,
  type ScopeType,
  type TimeWindow,
} from '@devanalytics/core';
import type { Database, ScopedSql } from '@devanalytics/db';
import { requireMetricDefinition, type MetricDefinition } from './definitions.js';
import { exclusionQuery, factQuery, supportsDimension, type Dimension, type FactContext } from './facts.js';

export interface MetricRequest {
  orgId: string;
  metric: string;
  scopeType: ScopeType;
  scopeId: string;
  window: TimeWindow;
  filters?: AnalyticsFilters;
}

export interface MetricValue {
  metric: string;
  definition: MetricDefinition;
  scopeType: ScopeType;
  scopeId: string;
  window: TimeWindow;
  result: MetricResult;
  /** Sufficient statistics, so callers can re-aggregate without re-querying. */
  numerator: number | null;
  denominator: number | null;
  /** Records the metric deliberately left out, with the reason. */
  excluded?: { count: number; reason: string };
}

export interface SeriesPoint {
  bucketStart: string;
  result: MetricResult;
  numerator: number | null;
  denominator: number | null;
}

export interface BreakdownRow {
  dimension: Dimension;
  key: string;
  label: string;
  result: MetricResult;
  numerator: number | null;
  denominator: number | null;
}

interface AggRow {
  n: string | number;
  num: string | number | null;
  den: string | number | null;
  p50: string | number | null;
}

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

function daysIn(window: TimeWindow): number {
  return Math.max(windowLengthMs(window) / MS_PER_DAY, 1 / 24);
}

/**
 * Turn aggregated sufficient statistics into a value, or into an explicit
 * `insufficient_data`. This is the only place a metric number is produced.
 */
function finalize(def: MetricDefinition, row: AggRow | null, window: TimeWindow): {
  result: MetricResult;
  numerator: number | null;
  denominator: number | null;
} {
  const n = row ? Number(row.n) : 0;
  const numerator = row ? num(row.num) : null;
  const denominator = row ? num(row.den) : null;

  if (n < def.minimumSampleSize) {
    return {
      result: insufficient(n === 0 ? 'no_data' : 'below_minimum_sample', n, def.minimumSampleSize),
      numerator,
      denominator,
    };
  }

  switch (def.aggregation) {
    case 'median': {
      const p50 = row ? num(row.p50) : null;
      if (p50 === null) return { result: insufficient('no_data', n, def.minimumSampleSize), numerator, denominator };
      return { result: ok(p50, n), numerator, denominator };
    }
    case 'mean':
    case 'rate': {
      if (!denominator) return { result: insufficient('no_data', n, def.minimumSampleSize), numerator, denominator };
      return { result: ok((numerator ?? 0) / denominator, n), numerator, denominator };
    }
    case 'per_day': {
      const days = daysIn(window);
      return { result: ok(n / days, n), numerator: n, denominator: days };
    }
  }
}

/**
 * The analytics engine.
 *
 * Every number the product shows comes from one of these four methods. They
 * differ only in how the fact rows are grouped.
 */
export class MetricEngine {
  constructor(private readonly db: Database) {}

  private context(req: MetricRequest): FactContext {
    return {
      orgId: req.orgId,
      scopeType: req.scopeType,
      scopeId: req.scopeId,
      window: req.window,
      filters: { ...DEFAULT_FILTERS, ...(req.filters ?? {}) },
    };
  }

  /** Single value over the whole window. */
  async value(req: MetricRequest): Promise<MetricValue> {
    const def = requireMetricDefinition(req.metric);
    const base = {
      metric: def.id, definition: def, scopeType: req.scopeType, scopeId: req.scopeId, window: req.window,
    };
    if (!def.supportedScopes.includes(req.scopeType)) {
      return { ...base, result: insufficient('metric_not_supported_for_scope', 0, def.minimumSampleSize), numerator: null, denominator: null };
    }
    return this.db.withOrg(req.orgId, async (sql) => {
      const { result, numerator, denominator } = await this.aggregate(sql, def, this.context(req));
      const excluded = await this.exclusions(sql, def, this.context(req));
      return { ...base, result, numerator, denominator, ...(excluded ? { excluded } : {}) };
    }, 'readonly');
  }

  /** Current window versus the immediately preceding window of equal length. */
  async comparison(req: MetricRequest): Promise<{ current: MetricValue; previous: MetricValue; comparison: Comparison }> {
    const prevWindow = previousWindow(req.window);
    const [current, previous] = await Promise.all([
      this.value(req),
      this.value({ ...req, window: prevWindow }),
    ]);
    return { current, previous, comparison: compare(current.result, previous.result) };
  }

  /** Bucketed history across the window. */
  async series(req: MetricRequest & { granularity: Granularity }): Promise<SeriesPoint[]> {
    const def = requireMetricDefinition(req.metric);
    if (!def.supportedScopes.includes(req.scopeType)) return [];
    const ctx = this.context(req);
    const fact = factQuery(def.id, ctx);
    const bucketMs = req.granularity === 'day' ? MS_PER_DAY : req.granularity === 'week' ? 7 * MS_PER_DAY : 30 * MS_PER_DAY;

    return this.db.withOrg(req.orgId, async (sql) => {
      const rows = await sql.many<AggRow & { bucket: Date }>(
        `select date_trunc($${fact.params.length + 1}, ts) as bucket,
                count(*)::int as n,
                sum(num) as num,
                sum(den) as den,
                percentile_cont(0.5) within group (order by val) as p50
           from (${fact.text}) f
          group by 1
          order by 1`,
        [...fact.params, req.granularity],
      );
      return rows.map((r) => {
        const start = new Date(r.bucket);
        const bucketWindow: TimeWindow = {
          from: start.toISOString(),
          to: new Date(start.getTime() + bucketMs).toISOString(),
        };
        const f = finalize(def, r, bucketWindow);
        return { bucketStart: start.toISOString(), result: f.result, numerator: f.numerator, denominator: f.denominator };
      });
    }, 'readonly');
  }

  /** The same window sliced by repository, team, branch or author. */
  async breakdown(req: MetricRequest, dimension: Dimension, limit = 50): Promise<BreakdownRow[]> {
    const def = requireMetricDefinition(req.metric);
    if (!def.supportedScopes.includes(req.scopeType)) return [];
    if (!supportsDimension(def.id, dimension)) return [];
    const ctx = this.context(req);
    const fact = factQuery(def.id, ctx, dimension);

    return this.db.withOrg(req.orgId, async (sql) => {
      const rows = await sql.many<AggRow & { dim_id: string; dim_label: string }>(
        `select dim_id, max(dim_label) as dim_label,
                count(*)::int as n, sum(num) as num, sum(den) as den,
                percentile_cont(0.5) within group (order by val) as p50
           from (${fact.text}) f
          group by dim_id
          order by n desc
          limit $${fact.params.length + 1}`,
        [...fact.params, limit],
      );
      return rows.map((r) => {
        const f = finalize(def, r, req.window);
        return {
          dimension, key: r.dim_id, label: r.dim_label,
          result: f.result, numerator: f.numerator, denominator: f.denominator,
        };
      });
    }, 'readonly');
  }

  /** Raw observations behind a metric, for drill-down from a chart to the records. */
  async facts(req: MetricRequest, limit = 200): Promise<{ ts: string; val: number | null }[]> {
    const def = requireMetricDefinition(req.metric);
    const fact = factQuery(def.id, this.context(req));
    return this.db.withOrg(req.orgId, async (sql) => {
      const rows = await sql.many<{ ts: Date; val: number | null }>(
        `select ts, val from (${fact.text}) f order by ts desc limit $${fact.params.length + 1}`,
        [...fact.params, limit],
      );
      return rows.map((r) => ({ ts: new Date(r.ts).toISOString(), val: r.val === null ? null : Number(r.val) }));
    }, 'readonly');
  }

  private async aggregate(sql: ScopedSql, def: MetricDefinition, ctx: FactContext) {
    const fact = factQuery(def.id, ctx);
    const row = await sql.one<AggRow>(
      `select count(*)::int as n, sum(num) as num, sum(den) as den,
              percentile_cont(0.5) within group (order by val) as p50
         from (${fact.text}) f`,
      fact.params,
    );
    return finalize(def, row, ctx.window);
  }

  private async exclusions(sql: ScopedSql, def: MetricDefinition, ctx: FactContext) {
    const q = exclusionQuery(def.id, ctx);
    if (!q) return null;
    const row = await sql.one<{ excluded: number }>(q.text, q.params);
    const count = Number(row?.excluded ?? 0);
    if (!count) return null;
    const reason =
      def.id === 'pr_size'
        ? 'Pull requests whose provider did not report diff statistics. They are excluded rather than counted as zero lines.'
        : 'Production deployments with no linked pull request cannot be attributed to a commit.';
    return { count, reason };
  }
}
