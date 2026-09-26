import type { Period, TimeWindow, Granularity } from './time.js';
import type { ScopeType } from './domain.js';

/**
 * A fully-resolved analytics query. Everything in the platform — dashboards,
 * API, SDK, MCP and the AI layer — computes metrics by constructing one of these.
 * There is no other path into the metric engine.
 */
export interface AnalyticsQuery {
  orgId: string;
  metric: string;
  scopeType: ScopeType;
  /** Scope entity id; for `org` scope this equals `orgId`. */
  scopeId: string;
  window: TimeWindow;
  filters: AnalyticsFilters;
}

export interface AnalyticsFilters {
  repositoryIds?: string[];
  teamIds?: string[];
  branches?: string[];
  authorUserIds?: string[];
  /** Exclude PRs/commits authored by bots. Defaults to true in every entry point. */
  excludeBots?: boolean;
  /** Only production deployments count toward DORA deployment metrics. */
  productionOnly?: boolean;
}

export const DEFAULT_FILTERS: AnalyticsFilters = { excludeBots: true, productionOnly: true };

export interface TimeSeriesQuery extends AnalyticsQuery {
  granularity: Granularity;
}

export interface GlobalFilterState {
  orgId: string;
  period: Period;
  repositoryIds: string[];
  teamIds: string[];
  branches: string[];
}
