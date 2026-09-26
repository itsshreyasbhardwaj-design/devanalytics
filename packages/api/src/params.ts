import {
  DEFAULT_FILTERS,
  PERIOD_DAYS,
  ValidationError,
  windowForPeriod,
  type AnalyticsFilters,
  type Granularity,
  type Period,
  type ScopeType,
  type TimeWindow,
} from '@devanalytics/core';

/**
 * Query parsing.
 *
 * Global filters mean the same thing on every endpoint, so they are parsed in
 * exactly one place. A caller that passes nonsense gets a 400 naming the
 * parameter, never a silently different window than they asked for.
 */

const SCOPE_TYPES: ScopeType[] = ['org', 'repository', 'team', 'branch', 'developer'];
const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];

export interface ParsedQuery {
  scopeType: ScopeType;
  scopeId: string | null;
  window: TimeWindow;
  period: Period | null;
  granularity: Granularity;
  filters: AnalyticsFilters;
  limit: number;
  offset: number;
}

export function parseQuery(url: URL, orgId: string, now: Date = new Date()): ParsedQuery {
  const scopeTypeRaw = url.searchParams.get('scopeType') ?? 'org';
  if (!SCOPE_TYPES.includes(scopeTypeRaw as ScopeType)) {
    throw new ValidationError(`Invalid scopeType "${scopeTypeRaw}"`, { allowed: SCOPE_TYPES });
  }
  const scopeType = scopeTypeRaw as ScopeType;
  const scopeId = url.searchParams.get('scopeId') ?? (scopeType === 'org' ? orgId : null);
  if (scopeType !== 'org' && !scopeId) {
    throw new ValidationError(`scopeId is required when scopeType is "${scopeType}"`);
  }

  const granularityRaw = url.searchParams.get('granularity') ?? 'day';
  if (!GRANULARITIES.includes(granularityRaw as Granularity)) {
    throw new ValidationError(`Invalid granularity "${granularityRaw}"`, { allowed: GRANULARITIES });
  }

  return {
    scopeType,
    scopeId,
    ...parseWindow(url, now),
    granularity: granularityRaw as Granularity,
    filters: parseFilters(url),
    limit: clampInt(url.searchParams.get('limit'), 50, 1, 500),
    offset: clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000),
  };
}

export function parseWindow(url: URL, now: Date = new Date()): { window: TimeWindow; period: Period | null } {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from || to) {
    if (!from || !to) throw new ValidationError('Both "from" and "to" are required when either is given');
    const f = new Date(from);
    const t = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      throw new ValidationError('"from" and "to" must be ISO-8601 timestamps');
    }
    if (f >= t) throw new ValidationError('"from" must be strictly before "to"');
    return { window: { from: f.toISOString(), to: t.toISOString() }, period: null };
  }
  const periodRaw = url.searchParams.get('period') ?? '30d';
  if (!(periodRaw in PERIOD_DAYS)) {
    throw new ValidationError(`Invalid period "${periodRaw}"`, { allowed: Object.keys(PERIOD_DAYS) });
  }
  const period = periodRaw as Period;
  return { window: windowForPeriod(period, now), period };
}

export function parseFilters(url: URL): AnalyticsFilters {
  const list = (name: string): string[] | undefined => {
    const raw = url.searchParams.getAll(name).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    return raw.length > 0 ? raw : undefined;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ValidationError(`"${name}" must be true or false`);
  };
  const filters: AnalyticsFilters = {
    excludeBots: bool('excludeBots', DEFAULT_FILTERS.excludeBots ?? true),
    productionOnly: bool('productionOnly', DEFAULT_FILTERS.productionOnly ?? true),
  };
  const repositoryIds = list('repositoryId');
  const teamIds = list('teamId');
  const branches = list('branch');
  const authorUserIds = list('authorUserId');
  if (repositoryIds) filters.repositoryIds = repositoryIds;
  if (teamIds) filters.teamIds = teamIds;
  if (branches) filters.branches = branches;
  if (authorUserIds) filters.authorUserIds = authorUserIds;
  return filters;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ValidationError(`Expected an integer, got "${raw}"`);
  return Math.min(max, Math.max(min, n));
}
