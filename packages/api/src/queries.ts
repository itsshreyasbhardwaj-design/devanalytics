import type { ScopeType, TimeWindow } from '@devanalytics/core';
import { NotFoundError } from '@devanalytics/core';
import { getPullRequest, listRepositories, type Database } from '@devanalytics/db';
import { type MetricEngine, formatMetric, requireMetricDefinition } from '@devanalytics/metrics';

/**
 * Composite reads for the dashboard and the data explorer.
 *
 * Every one of these funnels through Database.withOrg, so the row-level
 * security policy applies even to the ad-hoc joins.
 */

export interface RepositoryHealth {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  teamName: string | null;
  /** Deliberately a list of named metrics, not a single opaque score. */
  metrics: {
    metric: string;
    name: string;
    value: string;
    raw: number | null;
    sampleSize: number;
    status: 'ok' | 'insufficient_data';
    direction: 'lower_is_better' | 'higher_is_better' | 'neutral';
    relativeChange: number | null;
  }[];
  openPullRequests: number;
  recentAnomalies: { id: string; metric: string; severity: string; confidence: string; detectedAt: string }[];
}

const HEALTH_METRICS = [
  'pr_cycle_time',
  'time_to_first_review',
  'review_turnaround_time',
  'pr_size',
  'build_success_rate',
  'build_duration',
  'ci_queue_time',
  'deployment_frequency',
  'failed_deployment_rate',
  'review_participation',
];

export async function repositoryHealth(
  db: Database,
  engine: MetricEngine,
  input: { orgId: string; repoId: string; window: TimeWindow },
): Promise<RepositoryHealth> {
  const meta = await db.withOrg(input.orgId, (sql) =>
    sql.one<{ id: string; full_name: string; default_branch: string; is_private: boolean; team_name: string | null; open_prs: number }>(
      `select r.id, r.full_name, r.default_branch, r.is_private, t.name as team_name,
              (select count(*)::int from pull_requests p where p.repo_id = r.id and p.state = 'open') as open_prs
         from repositories r left join teams t on t.id = r.team_id
        where r.id = $1`,
      [input.repoId],
    ), 'readonly');
  if (!meta) throw new NotFoundError('Repository', input.repoId);

  const metrics = await Promise.all(
    HEALTH_METRICS.map(async (metric) => {
      const def = requireMetricDefinition(metric);
      const { current, comparison } = await engine.comparison({
        orgId: input.orgId, metric, scopeType: 'repository', scopeId: input.repoId, window: input.window,
      });
      return {
        metric,
        name: def.name,
        value: formatMetric(metric, current.result),
        raw: current.result.status === 'ok' ? current.result.value : null,
        sampleSize: current.result.sampleSize,
        status: current.result.status,
        direction: def.direction,
        relativeChange: comparison.relativeChange,
      };
    }),
  );

  const anomalies = await db.withOrg(input.orgId, (sql) =>
    sql.many<{ id: string; metric: string; severity: string; confidence: string; detected_at: Date }>(
      `select id, metric, severity, confidence, detected_at from anomalies
        where scope_type = 'repository' and scope_id = $1 and status <> 'resolved'
        order by detected_at desc limit 10`,
      [input.repoId],
    ), 'readonly');

  return {
    id: meta.id,
    fullName: meta.full_name,
    defaultBranch: meta.default_branch,
    isPrivate: meta.is_private,
    teamName: meta.team_name,
    metrics,
    openPullRequests: Number(meta.open_prs),
    recentAnomalies: anomalies.map((a) => ({
      id: a.id, metric: a.metric, severity: a.severity, confidence: a.confidence,
      detectedAt: new Date(a.detected_at).toISOString(),
    })),
  };
}

export interface PullRequestTimelineEntry {
  at: string;
  kind: 'ready_for_review' | 'commit' | 'review' | 'review_comment' | 'ci_run' | 'merged' | 'closed' | 'deployment';
  label: string;
  detail: Record<string, string | number | null>;
}

export interface PullRequestDetail {
  pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
  durations: { cycleTimeHours: number | null; timeToFirstReviewHours: number | null; mergeAfterApprovalHours: number | null };
  reviewers: { login: string | null; state: string; submittedAt: string }[];
  workflowRuns: { id: string; name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; queueMinutes: number | null; durationMinutes: number | null }[];
  deployments: { id: string; environment: string; state: string; createdAt: string; isProduction: boolean }[];
  commits: { sha: string; message: string; authoredAt: string; additions: number | null; deletions: number | null }[];
  timeline: PullRequestTimelineEntry[];
}

const hours = (a: Date | string | null, b: Date | string | null): number | null =>
  a && b ? Number(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000).toFixed(3)) : null;

export async function pullRequestDetail(db: Database, orgId: string, prId: string): Promise<PullRequestDetail> {
  return db.withOrg(orgId, async (sql) => {
    const pr = await getPullRequest(sql, prId);
    if (!pr) throw new NotFoundError('Pull request', prId);

    const reviews = await sql.many<{ login: string | null; state: string; submitted_at: Date }>(
      `select u.login, rv.state, rv.submitted_at
         from reviews rv left join users u on u.id = rv.reviewer_user_id
        where rv.pull_request_id = $1 order by rv.submitted_at`,
      [prId],
    );
    const comments = await sql.many<{ login: string | null; created_at: Date; path: string | null }>(
      `select u.login, rc.created_at, rc.path
         from review_comments rc left join users u on u.id = rc.author_user_id
        where rc.pull_request_id = $1 order by rc.created_at`,
      [prId],
    );
    const runs = await sql.many<{
      id: string; name: string; conclusion: string | null; created_at: Date; started_at: Date | null; completed_at: Date | null;
    }>(
      `select wr.id, w.name, wr.conclusion, wr.created_at, wr.started_at, wr.completed_at
         from workflow_runs wr join workflows w on w.id = wr.workflow_id
        where wr.pull_request_id = $1 order by wr.created_at`,
      [prId],
    );
    const deployments = await sql.many<{ id: string; environment: string; state: string; created_at: Date; is_production: boolean }>(
      `select id, environment, state, created_at, is_production from deployments where pull_request_id = $1 order by created_at`,
      [prId],
    );
    const commits = await sql.many<{ sha: string; message: string; authored_at: Date; additions: number | null; deletions: number | null }>(
      `select sha, message, authored_at, additions, deletions from commits where pull_request_id = $1 order by authored_at`,
      [prId],
    );

    const timeline: PullRequestTimelineEntry[] = [];
    if (pr.readyForReviewAt) {
      timeline.push({ at: pr.readyForReviewAt, kind: 'ready_for_review', label: 'Ready for review', detail: {} });
    }
    for (const c of commits) {
      timeline.push({
        at: new Date(c.authored_at).toISOString(), kind: 'commit',
        label: c.message.split('\n')[0]?.slice(0, 90) ?? c.sha.slice(0, 8),
        detail: { sha: c.sha.slice(0, 8), additions: c.additions, deletions: c.deletions },
      });
    }
    for (const r of reviews) {
      timeline.push({
        at: new Date(r.submitted_at).toISOString(), kind: 'review',
        label: `${r.login ?? 'unknown'} ${r.state.replace('_', ' ')}`, detail: { state: r.state },
      });
    }
    for (const c of comments) {
      timeline.push({
        at: new Date(c.created_at).toISOString(), kind: 'review_comment',
        label: `${c.login ?? 'unknown'} commented`, detail: { path: c.path },
      });
    }
    for (const r of runs) {
      timeline.push({
        at: new Date(r.created_at).toISOString(), kind: 'ci_run',
        label: `${r.name} ${r.conclusion ?? 'running'}`,
        detail: {
          queueMinutes: r.started_at ? Number((((new Date(r.started_at).getTime() - new Date(r.created_at).getTime()) / 60_000)).toFixed(2)) : null,
          durationMinutes: r.started_at && r.completed_at ? Number((((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 60_000)).toFixed(2)) : null,
        },
      });
    }
    if (pr.mergedAt) timeline.push({ at: pr.mergedAt, kind: 'merged', label: 'Merged', detail: { sha: pr.mergeCommitSha } });
    else if (pr.closedAt) timeline.push({ at: pr.closedAt, kind: 'closed', label: 'Closed without merging', detail: {} });
    for (const d of deployments) {
      timeline.push({
        at: new Date(d.created_at).toISOString(), kind: 'deployment',
        label: `Deployed to ${d.environment} (${d.state})`, detail: { environment: d.environment, state: d.state },
      });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    return {
      pullRequest: pr,
      durations: {
        cycleTimeHours: hours(pr.readyForReviewAt, pr.mergedAt),
        timeToFirstReviewHours: hours(pr.readyForReviewAt, pr.firstReviewAt),
        mergeAfterApprovalHours: hours(pr.firstApprovalAt, pr.mergedAt),
      },
      reviewers: reviews.map((r) => ({ login: r.login, state: r.state, submittedAt: new Date(r.submitted_at).toISOString() })),
      workflowRuns: runs.map((r) => ({
        id: r.id, name: r.name, conclusion: r.conclusion,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
        queueMinutes: r.started_at ? Number((((new Date(r.started_at).getTime() - new Date(r.created_at).getTime()) / 60_000)).toFixed(2)) : null,
        durationMinutes: r.started_at && r.completed_at ? Number((((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 60_000)).toFixed(2)) : null,
      })),
      deployments: deployments.map((d) => ({
        id: d.id, environment: d.environment, state: d.state,
        createdAt: new Date(d.created_at).toISOString(), isProduction: d.is_production,
      })),
      commits: commits.map((c) => ({
        sha: c.sha, message: c.message, authoredAt: new Date(c.authored_at).toISOString(),
        additions: c.additions, deletions: c.deletions,
      })),
      timeline,
    };
  }, 'readonly');
}

export async function listOrgRepositories(db: Database, orgId: string) {
  return db.withOrg(orgId, (sql) => listRepositories(sql), 'readonly');
}

export async function listTeams(db: Database, orgId: string) {
  return db.withOrg(orgId, (sql) =>
    sql.many<{ id: string; slug: string; name: string; repos: number; members: number }>(
      `select t.id, t.slug, t.name,
              (select count(*)::int from repositories r where r.team_id = t.id) as repos,
              (select count(*)::int from team_members m where m.team_id = t.id) as members
         from teams t order by t.name`,
    ), 'readonly');
}

/** Data explorer: raw events with their provenance. */
export async function listEvents(
  db: Database,
  orgId: string,
  opts: { type?: string; repoId?: string; limit: number; offset: number },
) {
  return db.withOrg(orgId, async (sql) => {
    const where = ['e.org_id = $1'];
    const params: (string | number)[] = [orgId];
    if (opts.type) { params.push(opts.type); where.push(`e.type = $${params.length}`); }
    if (opts.repoId) { params.push(opts.repoId); where.push(`e.repo_id = $${params.length}`); }
    params.push(opts.limit, opts.offset);
    return sql.many<{
      id: string; type: string; provider: string; occurred_at: Date; received_at: Date;
      processed_at: Date | null; process_error: string | null; full_name: string | null; idempotency_key: string;
    }>(
      `select e.id, e.type, e.provider, e.occurred_at, e.received_at, e.processed_at, e.process_error,
              r.full_name, e.idempotency_key
         from events e left join repositories r on r.id = e.repo_id
        where ${where.join(' and ')}
        order by e.occurred_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
  }, 'readonly');
}

export async function listWorkflowRuns(
  db: Database,
  orgId: string,
  opts: { repoId?: string; conclusion?: string; limit: number; offset: number },
) {
  return db.withOrg(orgId, async (sql) => {
    const where = ['wr.org_id = $1'];
    const params: (string | number)[] = [orgId];
    if (opts.repoId) { params.push(opts.repoId); where.push(`wr.repo_id = $${params.length}`); }
    if (opts.conclusion) { params.push(opts.conclusion); where.push(`wr.conclusion = $${params.length}`); }
    params.push(opts.limit, opts.offset);
    return sql.many(
      `select wr.id, w.name, r.full_name as repository, wr.head_branch, wr.conclusion, wr.status,
              wr.created_at, wr.started_at, wr.completed_at, wr.run_attempt, wr.pull_request_id
         from workflow_runs wr
         join workflows w on w.id = wr.workflow_id
         join repositories r on r.id = wr.repo_id
        where ${where.join(' and ')}
        order by wr.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
  }, 'readonly');
}

export async function listDeployments(
  db: Database,
  orgId: string,
  opts: { repoId?: string; productionOnly: boolean; limit: number; offset: number },
) {
  return db.withOrg(orgId, async (sql) => {
    const where = ['d.org_id = $1'];
    const params: (string | number | boolean)[] = [orgId];
    if (opts.repoId) { params.push(opts.repoId); where.push(`d.repo_id = $${params.length}`); }
    if (opts.productionOnly) where.push('d.is_production = true');
    params.push(opts.limit, opts.offset);
    return sql.many(
      `select d.id, r.full_name as repository, d.environment, d.is_production, d.state, d.sha,
              d.created_at, d.completed_at, d.pull_request_id
         from deployments d join repositories r on r.id = d.repo_id
        where ${where.join(' and ')}
        order by d.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
  }, 'readonly');
}

export async function listAnomalies(
  db: Database,
  orgId: string,
  opts: { status?: string; metric?: string; scopeType?: ScopeType; limit: number },
) {
  return db.withOrg(orgId, async (sql) => {
    const where = ['a.org_id = $1'];
    const params: (string | number)[] = [orgId];
    if (opts.status) { params.push(opts.status); where.push(`a.status = $${params.length}`); }
    if (opts.metric) { params.push(opts.metric); where.push(`a.metric = $${params.length}`); }
    if (opts.scopeType) { params.push(opts.scopeType); where.push(`a.scope_type = $${params.length}`); }
    params.push(opts.limit);
    return sql.many(
      `select a.*, coalesce(r.full_name, t.name, o.name, a.scope_id) as scope_label
         from anomalies a
         left join repositories r on r.id = a.scope_id
         left join teams t on t.id = a.scope_id
         left join organizations o on o.id = a.scope_id
        where ${where.join(' and ')}
        order by a.detected_at desc, a.score desc
        limit $${params.length}`,
      params,
    );
  }, 'readonly');
}

export async function organizationSummary(db: Database, orgId: string) {
  return db.withOrg(orgId, (sql) =>
    sql.one<{
      id: string; slug: string; name: string; is_demo: boolean;
      repositories: number; pull_requests: number; events: number; last_event_at: Date | null;
    }>(
      `select o.id, o.slug, o.name, o.is_demo,
              (select count(*)::int from repositories) as repositories,
              (select count(*)::int from pull_requests) as pull_requests,
              (select count(*)::int from events) as events,
              (select max(occurred_at) from events) as last_event_at
         from organizations o where o.id = $1`,
      [orgId],
    ), 'readonly');
}
