import {
  MS_PER_DAY,
  bucketStart,
  insufficient,
  ok,
  stableId,
  type Granularity,
  type MetricResult,
  type ScopeType,
  type TimeWindow,
} from '@devanalytics/core';
import type { Database } from '@devanalytics/db';
import { METRIC_IDS, isAggregatable, requireMetricDefinition } from './definitions.js';
import type { MetricEngine } from './engine.js';

/**
 * Precomputed metric snapshots.
 *
 * Dashboards read snapshots, not raw events. Each row stores the value *and*
 * its sufficient statistics (numerator, denominator, sample size), so a week
 * or a month can be rebuilt by summing days for every metric whose aggregation
 * permits it. Median metrics are explicitly excluded from that path — the
 * median of daily medians is not the median — and are recomputed from facts.
 */

export interface SnapshotScope {
  scopeType: ScopeType;
  scopeId: string;
}

export interface RefreshOptions {
  orgId: string;
  window: TimeWindow;
  granularity?: Granularity;
  metrics?: string[];
  scopes?: SnapshotScope[];
}

export interface RefreshReport {
  buckets: number;
  metrics: number;
  scopes: number;
  durationMs: number;
}

/** Org plus every connected repository plus every team. */
export async function defaultScopes(db: Database, orgId: string): Promise<SnapshotScope[]> {
  return db.withOrg(orgId, async (sql) => {
    const repos = await sql.many<{ id: string }>(`select id from repositories where archived_at is null order by id`);
    const teams = await sql.many<{ id: string }>(`select id from teams order by id`);
    return [
      { scopeType: 'org' as ScopeType, scopeId: orgId },
      ...repos.map((r) => ({ scopeType: 'repository' as ScopeType, scopeId: r.id })),
      ...teams.map((t) => ({ scopeType: 'team' as ScopeType, scopeId: t.id })),
    ];
  }, 'readonly');
}

export async function refreshSnapshots(
  db: Database,
  engine: MetricEngine,
  opts: RefreshOptions,
): Promise<RefreshReport> {
  const started = Date.now();
  const granularity = opts.granularity ?? 'day';
  const metrics = opts.metrics ?? METRIC_IDS;
  const scopes = opts.scopes ?? (await defaultScopes(db, opts.orgId));
  let buckets = 0;

  for (const scope of scopes) {
    for (const metric of metrics) {
      const def = requireMetricDefinition(metric);
      if (!def.supportedScopes.includes(scope.scopeType)) continue;

      // One query per (metric, scope) covering every bucket in the window.
      const points = await engine.series({
        orgId: opts.orgId,
        metric,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        window: opts.window,
        granularity,
      });
      if (points.length === 0) continue;

      await db.withOrg(opts.orgId, async (sql) => {
        for (const point of points) {
          const id = stableId('snap', opts.orgId, metric, scope.scopeType, scope.scopeId, granularity, point.bucketStart);
          await sql.query(
            `insert into metric_snapshots
               (id, org_id, metric, scope_type, scope_id, granularity, bucket_start, value, sample_size, numerator, denominator, computed_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
             on conflict (org_id, metric, scope_type, scope_id, granularity, bucket_start)
             do update set value = excluded.value,
                           sample_size = excluded.sample_size,
                           numerator = excluded.numerator,
                           denominator = excluded.denominator,
                           computed_at = now()`,
            [
              id, opts.orgId, metric, scope.scopeType, scope.scopeId, granularity, point.bucketStart,
              point.result.status === 'ok' ? point.result.value : null,
              point.result.sampleSize, point.numerator, point.denominator,
            ],
          );
          buckets++;
        }
      });
    }
  }

  return { buckets, metrics: metrics.length, scopes: scopes.length, durationMs: Date.now() - started };
}

export interface SnapshotPoint {
  bucketStart: string;
  value: number | null;
  sampleSize: number;
  numerator: number | null;
  denominator: number | null;
}

export async function readSnapshots(
  db: Database,
  input: { orgId: string; metric: string; scopeType: ScopeType; scopeId: string; granularity: Granularity; window: TimeWindow },
): Promise<SnapshotPoint[]> {
  return db.withOrg(input.orgId, async (sql) => {
    const rows = await sql.many<{ bucket_start: Date; value: number | null; sample_size: number; numerator: number | null; denominator: number | null }>(
      `select bucket_start, value, sample_size, numerator, denominator
         from metric_snapshots
        where org_id = $1 and metric = $2 and scope_type = $3 and scope_id = $4
          and granularity = $5 and bucket_start >= $6::timestamptz and bucket_start < $7::timestamptz
        order by bucket_start`,
      [input.orgId, input.metric, input.scopeType, input.scopeId, input.granularity, input.window.from, input.window.to],
    );
    return rows.map((r) => ({
      bucketStart: new Date(r.bucket_start).toISOString(),
      value: r.value === null ? null : Number(r.value),
      sampleSize: Number(r.sample_size),
      numerator: r.numerator === null ? null : Number(r.numerator),
      denominator: r.denominator === null ? null : Number(r.denominator),
    }));
  }, 'readonly');
}

/**
 * Roll snapshots up into one window value.
 *
 * Returns null for non-aggregatable metrics so the caller falls back to the
 * engine rather than silently averaging medians.
 */
export function aggregateSnapshots(metric: string, points: SnapshotPoint[], window: TimeWindow): MetricResult | null {
  const def = requireMetricDefinition(metric);
  if (!isAggregatable(def)) return null;

  const n = points.reduce((a, p) => a + p.sampleSize, 0);
  if (n < def.minimumSampleSize) {
    return insufficient(n === 0 ? 'no_data' : 'below_minimum_sample', n, def.minimumSampleSize);
  }
  if (def.aggregation === 'per_day') {
    const days = Math.max((new Date(window.to).getTime() - new Date(window.from).getTime()) / MS_PER_DAY, 1 / 24);
    return ok(n / days, n);
  }
  const numerator = points.reduce((a, p) => a + (p.numerator ?? 0), 0);
  const denominator = points.reduce((a, p) => a + (p.denominator ?? 0), 0);
  if (!denominator) return insufficient('no_data', n, def.minimumSampleSize);
  return ok(numerator / denominator, n);
}

/**
 * Incremental refresh.
 *
 * When an event lands we do not recompute the organization. We recompute only
 * the buckets that the event's timestamp can possibly have changed, for the
 * scopes that contain it.
 */
export function dirtyBuckets(occurredAt: string, granularities: Granularity[] = ['day', 'week', 'month']): { granularity: Granularity; bucketStart: string }[] {
  return granularities.map((g) => ({ granularity: g, bucketStart: bucketStart(occurredAt, g).toISOString() }));
}

export async function refreshBucket(
  db: Database,
  engine: MetricEngine,
  input: { orgId: string; scopes: SnapshotScope[]; metrics?: string[]; granularity: Granularity; bucketStart: string },
): Promise<RefreshReport> {
  const start = new Date(input.bucketStart);
  const end =
    input.granularity === 'day'
      ? new Date(start.getTime() + MS_PER_DAY)
      : input.granularity === 'week'
        ? new Date(start.getTime() + 7 * MS_PER_DAY)
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return refreshSnapshots(db, engine, {
    orgId: input.orgId,
    window: { from: start.toISOString(), to: end.toISOString() },
    granularity: input.granularity,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    scopes: input.scopes,
  });
}
