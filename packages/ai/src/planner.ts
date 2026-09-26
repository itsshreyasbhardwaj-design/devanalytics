import { PERIOD_DAYS, windowForPeriod, type Period, type ScopeType, type TimeWindow } from '@devanalytics/core';
import { METRIC_DEFINITIONS, METRIC_IDS } from '@devanalytics/metrics';

/**
 * Query understanding.
 *
 * A question becomes a *structured plan* — one of a small closed set of
 * intents with validated arguments — and the plan is executed by the same
 * analytics engine the dashboard uses. The model never writes a database
 * query, and it never invents a metric: the plan can only name metrics that
 * exist in the registry.
 *
 * The rule-based planner below handles the questions people actually ask and
 * runs with no model and no network. An LLM is consulted only when the rules
 * cannot identify a metric, and its output is validated against the same
 * schema before anything executes.
 */

export type Intent = 'metric_value' | 'metric_trend' | 'investigate' | 'contributors' | 'failure_patterns' | 'records' | 'unknown';

export interface AnalyticsPlan {
  orgId: string;
  intent: Intent;
  metric: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeHint: string | null;
  window: TimeWindow;
  period: Period | null;
  /** Dimension for contributor questions. */
  dimension: 'repository' | 'team' | 'branch' | 'author' | null;
  /** What the planner understood, shown to the user before results. */
  interpretation: string;
  confidence: 'high' | 'medium' | 'low';
  unresolved: string[];
}

const METRIC_SYNONYMS: Record<string, string[]> = {
  pr_cycle_time: ['cycle time', 'pr cycle', 'time to merge', 'pr duration', 'how long prs take', 'lead time for prs'],
  time_to_first_review: ['first review', 'time to review', 'review wait', 'waiting for review', 'review latency'],
  review_turnaround_time: ['review turnaround', 'reviewer speed', 'how fast reviewers'],
  merge_time: ['merge time', 'time to merge after approval', 'approval to merge'],
  pr_size: ['pr size', 'pull request size', 'lines changed', 'diff size', 'how big'],
  deployment_frequency: ['deployment frequency', 'deploy frequency', 'how often we deploy', 'deploys per day', 'release frequency'],
  lead_time_for_changes: ['lead time', 'lead time for changes', 'commit to production', 'time to production'],
  build_success_rate: ['build success', 'ci reliability', 'ci success', 'build pass rate', 'green builds', 'ci health', 'flaky', 'failed builds', 'failing builds', 'build failures', 'build failure', 'failed ci runs', 'broken builds'],
  build_duration: ['build duration', 'build time', 'ci duration', 'how long ci takes', 'pipeline duration'],
  ci_queue_time: ['queue time', 'ci queue', 'runner wait', 'waiting for a runner'],
  failed_deployment_rate: ['failed deployment', 'deployment failure', 'change failure', 'bad deploys'],
  reopened_pr_rate: ['reopened', 'rework'],
  review_participation: ['review participation', 'reviewers per pr', 'how many reviewers'],
  commit_frequency: ['commit frequency', 'commits per day', 'commit volume'],
};

const PERIOD_PHRASES: [RegExp, Period][] = [
  [/\b(today|last 24 hours|past day)\b/i, '1d'],
  [/\b(last|past)\s+(7|seven)\s*days?\b|\blast week\b|\bthis week\b/i, '7d'],
  [/\b(last|past)\s+(30|thirty)\s*days?\b|\blast month\b|\bthis month\b/i, '30d'],
  [/\b(last|past)\s+(90|ninety)\s*days?\b|\blast quarter\b|\bthis quarter\b/i, '90d'],
  [/\b(last|past)\s+(365|year)\b|\blast year\b|\bthis year\b/i, '365d'],
];

const INCREASE = /\b(increase[d]?|rise|risen|rose|up|slower|worse|regress|degrad|spike[d]?|jump[ed]?|longer)\b/i;
const DECREASE = /\b(decrease[d]?|drop|dropped|fell|down|faster|better|improve[d]?|shorter)\b/i;
const WHY = /\b(why|what caused|what changed|what happened|explain|root cause|reason)\b/i;
const WHICH = /\b(which|who|what)\s+(repositor|repos|team|branch|author|developer|service)/i;
const TREND = /\b(trend|over time|history|historical|week over week|month over month|chart|graph)\b/i;
const PATTERNS = /\b(pattern|patterns|common|correlat|cluster|characteristic)\b/i;
const RECORDS = /\b(list|show me|slowest|largest|biggest|examples?|which prs|top \d+)\b/i;
const FAILED_BUILDS = /\b(failed|failing|failure)s?\b.*\b(build|ci|run|pipeline)s?\b|\b(build|ci|pipeline)s?\b.*\b(failed|failing|failure)/i;

export interface PlannerContext {
  orgId: string;
  /** Known repository names, for scope resolution. */
  repositories: { id: string; fullName: string }[];
  teams: { id: string; name: string }[];
  now?: Date;
}

export function planQuestion(question: string, ctx: PlannerContext): AnalyticsPlan {
  const now = ctx.now ?? new Date();
  const q = question.toLowerCase();
  const unresolved: string[] = [];

  const metric = matchMetric(q);
  if (!metric) unresolved.push('metric');

  let period: Period = '30d';
  for (const [re, p] of PERIOD_PHRASES) {
    if (re.test(question)) { period = p; break; }
  }
  const explicitDays = /\b(\d{1,3})\s*days?\b/i.exec(question);
  if (explicitDays?.[1]) {
    const days = Number(explicitDays[1]);
    const closest = (Object.keys(PERIOD_DAYS) as Period[]).reduce((best, p) =>
      Math.abs(PERIOD_DAYS[p] - days) < Math.abs(PERIOD_DAYS[best] - days) ? p : best, '30d' as Period);
    period = closest;
  }

  const scope = resolveScope(question, ctx);

  let intent: Intent;
  let dimension: AnalyticsPlan['dimension'] = null;
  if (FAILED_BUILDS.test(question) && PATTERNS.test(question)) {
    intent = 'failure_patterns';
  } else if (WHICH.test(question)) {
    intent = 'contributors';
    dimension = /team/i.test(question) ? 'team' : /branch/i.test(question) ? 'branch' : /author|developer|who/i.test(question) ? 'author' : 'repository';
  } else if (WHY.test(question) || INCREASE.test(question) || DECREASE.test(question)) {
    intent = 'investigate';
  } else if (TREND.test(question)) {
    intent = 'metric_trend';
  } else if (RECORDS.test(question)) {
    intent = 'records';
  } else if (metric) {
    intent = 'metric_value';
  } else {
    intent = 'unknown';
  }

  const metricName = metric ? METRIC_DEFINITIONS[metric]?.name : null;
  const interpretation = metric
    ? `${describeIntent(intent, dimension)} for ${metricName} over the last ${PERIOD_DAYS[period]} days${scope.label ? `, scoped to ${scope.label}` : ''}.`
    : 'Could not identify which metric the question is about.';

  return {
    orgId: ctx.orgId,
    intent: metric ? intent : 'unknown',
    metric,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId ?? (scope.scopeType === 'org' ? ctx.orgId : null),
    scopeHint: scope.label,
    window: windowForPeriod(period, now),
    period,
    dimension,
    interpretation,
    confidence: metric ? (unresolved.length === 0 && intent !== 'unknown' ? 'high' : 'medium') : 'low',
    unresolved,
  };
}

function describeIntent(intent: Intent, dimension: AnalyticsPlan['dimension']): string {
  switch (intent) {
    case 'metric_value': return 'Current value';
    case 'metric_trend': return 'Trend';
    case 'investigate': return 'Change investigation';
    case 'contributors': return `Contribution by ${dimension ?? 'repository'}`;
    case 'failure_patterns': return 'Failure patterns';
    case 'records': return 'Underlying records';
    case 'unknown': return 'Unrecognised request';
  }
}

function matchMetric(q: string): string | null {
  // Longest synonym first, so "time to first review" wins over "review".
  const candidates: { metric: string; phrase: string }[] = [];
  for (const id of METRIC_IDS) {
    const def = METRIC_DEFINITIONS[id];
    if (!def) continue;
    candidates.push({ metric: id, phrase: def.name.toLowerCase() });
    candidates.push({ metric: id, phrase: id.replace(/_/g, ' ') });
    for (const syn of METRIC_SYNONYMS[id] ?? []) candidates.push({ metric: id, phrase: syn });
  }
  candidates.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const c of candidates) {
    if (q.includes(c.phrase)) return c.metric;
  }
  return null;
}

function resolveScope(question: string, ctx: PlannerContext): { scopeType: ScopeType; scopeId: string | null; label: string | null } {
  const q = question.toLowerCase();
  for (const repo of ctx.repositories) {
    const short = repo.fullName.split('/')[1]?.toLowerCase();
    if (q.includes(repo.fullName.toLowerCase()) || (short && short.length > 3 && new RegExp(`\\b${escapeRegExp(short)}\\b`).test(q))) {
      return { scopeType: 'repository', scopeId: repo.id, label: repo.fullName };
    }
  }
  for (const team of ctx.teams) {
    if (team.name.length > 3 && q.includes(team.name.toLowerCase())) {
      return { scopeType: 'team', scopeId: team.id, label: `team ${team.name}` };
    }
  }
  return { scopeType: 'org', scopeId: null, label: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
