import type { AnalyticsFilters, ScopeType, TimeWindow } from '@devanalytics/core';
import { requireMetricDefinition } from './definitions.js';
import { Params, HOURS, MINUTES, type FactQuery } from './sql.js';

/**
 * Fact queries.
 *
 * Every metric compiles to one query whose rows are the individual
 * observations that make up the metric:
 *
 *   ts  - the observation's time anchor, used for bucketing
 *   val - the observed quantity (null for pure counting metrics)
 *   num - numerator contribution
 *   den - denominator contribution
 *
 * Everything above this layer — window values, time series, breakdowns,
 * snapshots, anomaly baselines, investigations — is a different aggregation of
 * the same rows. There is exactly one definition of each metric in the system.
 */

export interface FactContext {
  orgId: string;
  scopeType: ScopeType;
  scopeId: string;
  window: TimeWindow;
  filters: AnalyticsFilters;
}

interface Base {
  /** FROM + JOINs. */
  from: string;
  /** Column holding the repository id. */
  repoCol: string;
  /** Column holding the team id (via repositories). */
  teamCol: string;
  /** Column holding a branch name, when the fact has one. */
  branchCol: string | null;
  /** Column holding the acting developer, when the fact has one. */
  authorCol: string | null;
  /** Column holding a bot flag for the acting developer. */
  botCol: string | null;
  /** Table alias carrying org_id. */
  orgCol: string;
}

const PR_BASE: Base = {
  from: `from pull_requests p
         join repositories r on r.id = p.repo_id
         left join teams tm on tm.id = r.team_id
         left join users au on au.id = p.author_user_id`,
  repoCol: 'p.repo_id', teamCol: 'r.team_id', branchCol: 'p.base_branch',
  authorCol: 'p.author_user_id', botCol: 'au.is_bot', orgCol: 'p.org_id',
};

const REVIEW_BASE: Base = {
  from: `from reviews rv
         join pull_requests p on p.id = rv.pull_request_id
         join repositories r on r.id = rv.repo_id
         left join teams tm on tm.id = r.team_id
         left join users ru on ru.id = rv.reviewer_user_id`,
  repoCol: 'rv.repo_id', teamCol: 'r.team_id', branchCol: 'p.base_branch',
  authorCol: 'rv.reviewer_user_id', botCol: 'ru.is_bot', orgCol: 'rv.org_id',
};

const RUN_BASE: Base = {
  from: `from workflow_runs wr
         join repositories r on r.id = wr.repo_id
         left join teams tm on tm.id = r.team_id`,
  repoCol: 'wr.repo_id', teamCol: 'r.team_id', branchCol: 'wr.head_branch',
  authorCol: null, botCol: null, orgCol: 'wr.org_id',
};

const DEPLOY_BASE: Base = {
  from: `from deployments dp
         join repositories r on r.id = dp.repo_id
         left join teams tm on tm.id = r.team_id`,
  repoCol: 'dp.repo_id', teamCol: 'r.team_id', branchCol: null,
  authorCol: null, botCol: null, orgCol: 'dp.org_id',
};

const COMMIT_BASE: Base = {
  from: `from commits c
         join repositories r on r.id = c.repo_id
         left join teams tm on tm.id = r.team_id
         left join users cu on cu.id = c.author_user_id`,
  repoCol: 'c.repo_id', teamCol: 'r.team_id', branchCol: 'c.branch',
  authorCol: 'c.author_user_id', botCol: 'cu.is_bot', orgCol: 'c.org_id',
};

interface Spec {
  base: Base;
  ts: string;
  val: string | null;
  num: string;
  den: string;
  where: string[];
}

function spec(metric: string): Spec {
  switch (metric) {
    case 'pr_cycle_time':
    case 'pr_cycle_time_mean':
      return {
        base: PR_BASE,
        ts: 'p.merged_at',
        val: HOURS('p.merged_at', 'p.ready_for_review_at'),
        num: HOURS('p.merged_at', 'p.ready_for_review_at'),
        den: '1',
        where: ['p.merged_at is not null', 'p.ready_for_review_at is not null', 'p.merged_at >= p.ready_for_review_at'],
      };

    case 'time_to_first_review':
      return {
        base: PR_BASE,
        ts: 'p.first_review_at',
        val: HOURS('p.first_review_at', 'p.ready_for_review_at'),
        num: HOURS('p.first_review_at', 'p.ready_for_review_at'),
        den: '1',
        where: ['p.first_review_at is not null', 'p.ready_for_review_at is not null', 'p.first_review_at >= p.ready_for_review_at'],
      };

    case 'review_turnaround_time':
      return {
        base: REVIEW_BASE,
        ts: 'rv.submitted_at',
        val: HOURS('rv.submitted_at', 'coalesce(rv.requested_at, p.ready_for_review_at)'),
        num: HOURS('rv.submitted_at', 'coalesce(rv.requested_at, p.ready_for_review_at)'),
        den: '1',
        where: [
          'coalesce(rv.requested_at, p.ready_for_review_at) is not null',
          'rv.submitted_at >= coalesce(rv.requested_at, p.ready_for_review_at)',
          // A reviewer approving their own PR is not a review turnaround.
          '(rv.reviewer_user_id is null or p.author_user_id is null or rv.reviewer_user_id <> p.author_user_id)',
        ],
      };

    case 'merge_time':
      return {
        base: PR_BASE,
        ts: 'p.merged_at',
        val: HOURS('p.merged_at', 'p.first_approval_at'),
        num: HOURS('p.merged_at', 'p.first_approval_at'),
        den: '1',
        where: ['p.merged_at is not null', 'p.first_approval_at is not null', 'p.merged_at >= p.first_approval_at'],
      };

    case 'pr_size':
      return {
        base: PR_BASE,
        ts: 'p.created_at',
        val: '(p.additions + p.deletions)::double precision',
        num: '(p.additions + p.deletions)::double precision',
        den: '1',
        where: [],
      };

    case 'deployment_frequency':
      return {
        base: DEPLOY_BASE,
        ts: 'dp.created_at',
        val: null,
        num: '1',
        den: '0', // denominator is elapsed days, supplied by the aggregator
        where: [`dp.state = 'success'`],
      };

    case 'lead_time_for_changes':
      return {
        base: {
          ...DEPLOY_BASE,
          from: `${DEPLOY_BASE.from}
         join pull_requests p on p.id = dp.pull_request_id
         join lateral (
           select min(c.authored_at) as first_commit_at
             from commits c
            where c.pull_request_id = p.id
         ) fc on true`,
        },
        ts: 'dp.created_at',
        val: HOURS('dp.created_at', 'fc.first_commit_at'),
        num: HOURS('dp.created_at', 'fc.first_commit_at'),
        den: '1',
        where: [`dp.state = 'success'`, 'dp.pull_request_id is not null', 'fc.first_commit_at is not null', 'dp.created_at >= fc.first_commit_at'],
      };

    case 'build_success_rate':
      return {
        base: RUN_BASE,
        ts: 'wr.completed_at',
        val: `case when wr.conclusion = 'success' then 1.0 else 0.0 end`,
        num: `case when wr.conclusion = 'success' then 1.0 else 0.0 end`,
        den: '1',
        // Cancelled and skipped runs say nothing about whether the build works.
        where: [`wr.conclusion in ('success','failure','timed_out')`, 'wr.completed_at is not null'],
      };

    case 'build_duration':
      return {
        base: RUN_BASE,
        ts: 'wr.completed_at',
        val: MINUTES('wr.completed_at', 'wr.started_at'),
        num: MINUTES('wr.completed_at', 'wr.started_at'),
        den: '1',
        where: ['wr.completed_at is not null', 'wr.started_at is not null', 'wr.completed_at >= wr.started_at'],
      };

    case 'ci_queue_time':
      return {
        base: RUN_BASE,
        ts: 'wr.created_at',
        val: MINUTES('wr.started_at', 'wr.created_at'),
        num: MINUTES('wr.started_at', 'wr.created_at'),
        den: '1',
        where: ['wr.started_at is not null', 'wr.started_at >= wr.created_at'],
      };

    case 'failed_deployment_rate':
      return {
        base: DEPLOY_BASE,
        ts: 'dp.created_at',
        val: `case when dp.state in ('failure','error') then 1.0 else 0.0 end`,
        num: `case when dp.state in ('failure','error') then 1.0 else 0.0 end`,
        den: '1',
        where: [`dp.state in ('success','failure','error')`],
      };

    case 'reopened_pr_rate':
      return {
        base: PR_BASE,
        ts: 'coalesce(p.merged_at, p.closed_at)',
        val: 'case when p.reopened_count > 0 then 1.0 else 0.0 end',
        num: 'case when p.reopened_count > 0 then 1.0 else 0.0 end',
        den: '1',
        where: ['coalesce(p.merged_at, p.closed_at) is not null'],
      };

    case 'review_participation':
      return {
        base: {
          ...PR_BASE,
          from: `${PR_BASE.from}
         join lateral (
           select count(distinct rv.reviewer_user_id) as reviewers
             from reviews rv
            where rv.pull_request_id = p.id
              and rv.reviewer_user_id is not null
              and (p.author_user_id is null or rv.reviewer_user_id <> p.author_user_id)
         ) rc on true`,
        },
        ts: 'p.merged_at',
        val: 'rc.reviewers::double precision',
        num: 'rc.reviewers::double precision',
        den: '1',
        where: ['p.merged_at is not null'],
      };

    case 'commit_frequency':
      return {
        base: COMMIT_BASE,
        ts: 'c.committed_at',
        val: null,
        num: '1',
        den: '0',
        where: [],
      };

    default:
      throw new Error(`No fact query defined for metric "${metric}"`);
  }
}

function scopePredicate(base: Base, ctx: FactContext, p: Params): string | null {
  switch (ctx.scopeType) {
    case 'org':
      return null;
    case 'repository':
      return `${base.repoCol} = ${p.add(ctx.scopeId)}`;
    case 'team':
      return `${base.teamCol} = ${p.add(ctx.scopeId)}`;
    case 'branch':
      if (!base.branchCol) throw new Error('branch scope unsupported for this metric');
      return `${base.branchCol} = ${p.add(ctx.scopeId)}`;
    case 'developer':
      if (!base.authorCol) throw new Error('developer scope unsupported for this metric');
      return `${base.authorCol} = ${p.add(ctx.scopeId)}`;
  }
}

function filterPredicates(base: Base, f: AnalyticsFilters, p: Params, metric: string): string[] {
  const out: string[] = [];
  if (f.repositoryIds?.length) out.push(`${base.repoCol} = any(${p.add(f.repositoryIds as unknown as object)}::text[])`);
  if (f.teamIds?.length) out.push(`${base.teamCol} = any(${p.add(f.teamIds as unknown as object)}::text[])`);
  if (f.branches?.length && base.branchCol) out.push(`${base.branchCol} = any(${p.add(f.branches as unknown as object)}::text[])`);
  if (f.authorUserIds?.length && base.authorCol) out.push(`${base.authorCol} = any(${p.add(f.authorUserIds as unknown as object)}::text[])`);
  // Bot-authored pull requests (dependency bumps, release automation) would
  // otherwise dominate throughput and size metrics in most repositories.
  if (f.excludeBots !== false && base.botCol) out.push(`coalesce(${base.botCol}, false) = false`);
  if (f.productionOnly !== false && (metric.startsWith('deployment') || metric.startsWith('failed_deployment') || metric === 'lead_time_for_changes')) {
    out.push('dp.is_production = true');
  }
  return out;
}

/**
 * Dimensions a metric delta can be decomposed along. Used by change
 * intelligence to answer "which slice of the organization moved?".
 */
export type Dimension = 'repository' | 'team' | 'branch' | 'author';

interface DimExpr { id: string; label: string }

function dimensionExpr(base: Base, dim: Dimension): DimExpr | null {
  switch (dim) {
    case 'repository':
      return { id: 'r.id', label: 'r.full_name' };
    case 'team':
      return { id: 'coalesce(r.team_id, \'__unassigned__\')', label: `coalesce(tm.name, 'Unassigned')` };
    case 'branch':
      return base.branchCol ? { id: `coalesce(${base.branchCol}, '__none__')`, label: `coalesce(${base.branchCol}, '(none)')` } : null;
    case 'author': {
      if (!base.authorCol) return null;
      const loginCol = base.botCol ? base.botCol.replace('.is_bot', '.login') : null;
      return loginCol
        ? { id: `coalesce(${base.authorCol}, '__unknown__')`, label: `coalesce(${loginCol}, '(unknown)')` }
        : null;
    }
  }
}

export function supportsDimension(metric: string, dim: Dimension): boolean {
  return dimensionExpr(spec(metric).base, dim) !== null;
}

/** Compile a metric to its fact query. */
export function factQuery(metric: string, ctx: FactContext, dimension?: Dimension): FactQuery {
  requireMetricDefinition(metric);
  const s = spec(metric);
  const p = new Params();
  const where: string[] = [
    `${s.base.orgCol} = ${p.add(ctx.orgId)}`,
    `${s.ts} >= ${p.add(ctx.window.from)}::timestamptz`,
    `${s.ts} <  ${p.add(ctx.window.to)}::timestamptz`,
    ...s.where,
  ];
  const scope = scopePredicate(s.base, ctx, p);
  if (scope) where.push(scope);
  where.push(...filterPredicates(s.base, ctx.filters, p, metric));

  let dimCols = '';
  if (dimension) {
    const dx = dimensionExpr(s.base, dimension);
    if (!dx) throw new Error(`Metric "${metric}" cannot be broken down by ${dimension}`);
    dimCols = `,\n       ${dx.id} as dim_id,\n       ${dx.label} as dim_label`;
  }

  const text = `select ${s.ts} as ts,
       ${s.val ?? 'null::double precision'} as val,
       (${s.num})::double precision as num,
       (${s.den})::double precision as den${dimCols}
  ${s.base.from}
 where ${where.join('\n   and ')}`;
  return { text, params: p.all };
}

/** Rows a metric excluded for want of a prerequisite, reported next to the value. */
export function exclusionQuery(metric: string, ctx: FactContext): FactQuery | null {
  if (metric !== 'lead_time_for_changes') return null;
  const p = new Params();
  return {
    text: `select count(*)::int as excluded
             from deployments dp
            where dp.org_id = ${p.add(ctx.orgId)}
              and dp.created_at >= ${p.add(ctx.window.from)}::timestamptz
              and dp.created_at <  ${p.add(ctx.window.to)}::timestamptz
              and dp.state = 'success'
              and dp.is_production = true
              and dp.pull_request_id is null`,
    params: p.all,
  };
}
