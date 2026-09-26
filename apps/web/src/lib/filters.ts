import 'server-only';
import { PERIOD_DAYS, windowForPeriod, type AnalyticsFilters, type Granularity, type Period, type TimeWindow } from '@devanalytics/core';

/**
 * Global filter state lives in the URL.
 *
 * Every page reads the same parameters, so a filtered view is a link you can
 * paste into an incident channel and everyone sees the same numbers. Nothing
 * filter-related is kept in component state.
 */
export interface DashboardFilters {
  period: Period;
  window: TimeWindow;
  granularity: Granularity;
  repositoryIds: string[];
  teamIds: string[];
  branches: string[];
  excludeBots: boolean;
  productionOnly: boolean;
}

export type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const many = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);

export function readFilters(params: SearchParams, now: Date = new Date()): DashboardFilters {
  const periodRaw = first(params.period) ?? '30d';
  const period = (periodRaw in PERIOD_DAYS ? periodRaw : '30d') as Period;

  // An explicit from/to wins over the relative period, so a link to a specific
  // window (from an anomaly or a saved investigation) keeps its window.
  const from = first(params.from);
  const to = first(params.to);
  const explicit =
    from && to && !Number.isNaN(Date.parse(from)) && !Number.isNaN(Date.parse(to)) && Date.parse(from) < Date.parse(to)
      ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
      : null;
  const window = explicit ?? windowForPeriod(period, now);
  const spanDays = (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000;

  const granularityRaw = first(params.granularity);
  const granularity: Granularity =
    granularityRaw === 'week' || granularityRaw === 'month' || granularityRaw === 'day'
      ? granularityRaw
      : spanDays > 120 ? 'week' : 'day';

  return {
    period,
    window,
    granularity,
    repositoryIds: many(params.repositoryId),
    teamIds: many(params.teamId),
    branches: many(params.branch),
    excludeBots: first(params.excludeBots) !== 'false',
    productionOnly: first(params.productionOnly) !== 'false',
  };
}

export function toAnalyticsFilters(f: DashboardFilters): AnalyticsFilters {
  const out: AnalyticsFilters = { excludeBots: f.excludeBots, productionOnly: f.productionOnly };
  if (f.repositoryIds.length) out.repositoryIds = f.repositoryIds;
  if (f.teamIds.length) out.teamIds = f.teamIds;
  if (f.branches.length) out.branches = f.branches;
  return out;
}

/** Serialise filters back into a query string, preserving extra params. */
export function filtersToQuery(f: Partial<DashboardFilters>, extra: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  if (f.period) p.set('period', f.period);
  if (f.window && extra.keepWindow === 'true') {
    p.set('from', f.window.from);
    p.set('to', f.window.to);
    delete extra.keepWindow;
  }
  if (f.granularity) p.set('granularity', f.granularity);
  for (const id of f.repositoryIds ?? []) p.append('repositoryId', id);
  for (const id of f.teamIds ?? []) p.append('teamId', id);
  for (const b of f.branches ?? []) p.append('branch', b);
  if (f.excludeBots === false) p.set('excludeBots', 'false');
  if (f.productionOnly === false) p.set('productionOnly', 'false');
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export { PERIOD_LABELS } from './periods.js';
