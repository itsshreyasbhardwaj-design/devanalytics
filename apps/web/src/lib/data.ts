import 'server-only';
import type { Comparison, MetricResult, ScopeType, TimeWindow } from '@devanalytics/core';
import { compare } from '@devanalytics/core';
import type { MetricValue } from '@devanalytics/metrics';
import { getRuntime } from './runtime.js';
import { toAnalyticsFilters, type DashboardFilters } from './filters.js';

/**
 * Server-side data loading.
 *
 * Pages call the analytics engine in-process rather than looping back through
 * HTTP. The same engine, the same filters and the same insufficient-data
 * semantics as the API — one code path, so the dashboard can never disagree
 * with the API about a number.
 */
export interface LoadedMetric {
  metric: string;
  value: MetricValue;
  comparison: Comparison;
}

export async function loadMetric(
  orgId: string,
  metric: string,
  filters: DashboardFilters,
  scope: { scopeType: ScopeType; scopeId: string },
): Promise<LoadedMetric> {
  const runtime = await getRuntime();
  const { current, previous } = await runtime.engine.comparison({
    orgId, metric, scopeType: scope.scopeType, scopeId: scope.scopeId,
    window: filters.window, filters: toAnalyticsFilters(filters),
  });
  return { metric, value: current, comparison: compare(current.result, previous.result) };
}

export async function loadMetrics(
  orgId: string,
  metrics: string[],
  filters: DashboardFilters,
  scope: { scopeType: ScopeType; scopeId: string },
): Promise<LoadedMetric[]> {
  // Sequential on purpose: the embedded engine serialises on one connection, so
  // fanning out here only queues work and makes traces harder to read.
  const out: LoadedMetric[] = [];
  for (const metric of metrics) out.push(await loadMetric(orgId, metric, filters, scope));
  return out;
}

export async function loadSeries(
  orgId: string,
  metric: string,
  filters: DashboardFilters,
  scope: { scopeType: ScopeType; scopeId: string },
): Promise<{ bucketStart: string; value: number | null; sampleSize: number }[]> {
  const runtime = await getRuntime();
  const points = await runtime.engine.series({
    orgId, metric, scopeType: scope.scopeType, scopeId: scope.scopeId,
    window: filters.window, filters: toAnalyticsFilters(filters), granularity: filters.granularity,
  });
  return points.map((p) => ({
    bucketStart: p.bucketStart,
    value: p.result.status === 'ok' ? p.result.value : null,
    sampleSize: p.result.sampleSize,
  }));
}

/** The scope a page should use, derived from the global filters. */
export function scopeFor(orgId: string, filters: DashboardFilters): { scopeType: ScopeType; scopeId: string } {
  if (filters.repositoryIds.length === 1) return { scopeType: 'repository', scopeId: filters.repositoryIds[0] as string };
  if (filters.teamIds.length === 1) return { scopeType: 'team', scopeId: filters.teamIds[0] as string };
  return { scopeType: 'org', scopeId: orgId };
}

export function describeWindow(window: TimeWindow): string {
  return `${window.from.slice(0, 10)} → ${window.to.slice(0, 10)}`;
}

export function sampleSizeOf(result: MetricResult): number {
  return result.sampleSize;
}
