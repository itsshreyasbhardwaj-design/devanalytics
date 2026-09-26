import { stableId } from '@devanalytics/core';
import type {
  Organization,
  PullRequest,
  Repository,
  ScopeType,
  Team,
  User,
} from '@devanalytics/core';
import type { Database, ScopedSql } from './client.js';

/**
 * Typed data access.
 *
 * Writes are idempotent upserts because the same logical fact can arrive from
 * a webhook, a webhook redelivery and a backfill. "First seen" timestamps use
 * `least(...)` and monotonic counters use `greatest(...)`, so events arriving
 * out of order converge on the same row rather than corrupting it.
 */

export interface UpsertOrgInput {
  slug: string;
  name: string;
  isDemo?: boolean;
}

export async function upsertOrganization(sql: ScopedSql, input: UpsertOrgInput): Promise<Organization> {
  const id = stableId('org', input.slug);
  const row = await sql.one<{
    id: string; slug: string; name: string; is_demo: boolean; created_at: Date;
  }>(
    `insert into organizations (id, slug, name, is_demo)
     values ($1, $2, $3, $4)
     on conflict (slug) do update set name = excluded.name, is_demo = excluded.is_demo
     returning id, slug, name, is_demo, created_at`,
    [id, input.slug, input.name, input.isDemo ?? false],
  );
  if (!row) throw new Error('organization upsert returned no row');
  return { id: row.id, slug: row.slug, name: row.name, isDemo: row.is_demo, createdAt: row.created_at.toISOString() };
}

export async function upsertTeam(sql: ScopedSql, input: { slug: string; name: string }): Promise<Team> {
  const id = stableId('team', sql.orgId, input.slug);
  await sql.query(
    `insert into teams (id, org_id, slug, name) values ($1, $2, $3, $4)
     on conflict (org_id, slug) do update set name = excluded.name`,
    [id, sql.orgId, input.slug, input.name],
  );
  return { id, orgId: sql.orgId, slug: input.slug, name: input.name };
}

export interface UpsertUserInput {
  provider: string;
  providerUserId: string;
  login: string;
  name?: string | null;
  isBot?: boolean;
}

export async function upsertUser(sql: ScopedSql, input: UpsertUserInput): Promise<User> {
  const id = stableId('user', sql.orgId, input.provider, input.providerUserId);
  await sql.query(
    `insert into users (id, org_id, provider, provider_user_id, login, name, is_bot)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (org_id, provider, provider_user_id)
     do update set login = excluded.login,
                   name = coalesce(excluded.name, users.name),
                   is_bot = excluded.is_bot`,
    [id, sql.orgId, input.provider, input.providerUserId, input.login, input.name ?? null, input.isBot ?? false],
  );
  return {
    id,
    orgId: sql.orgId,
    provider: input.provider as User['provider'],
    providerUserId: input.providerUserId,
    login: input.login,
    name: input.name ?? null,
    isBot: input.isBot ?? false,
  };
}

export interface UpsertRepoInput {
  provider: string;
  providerRepoId: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  teamId?: string | null;
}

export async function upsertRepository(sql: ScopedSql, input: UpsertRepoInput): Promise<Repository> {
  const id = stableId('repo', sql.orgId, input.provider, input.providerRepoId);
  await sql.query(
    `insert into repositories (id, org_id, provider, provider_repo_id, name, full_name, default_branch, is_private, team_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (org_id, provider, provider_repo_id) do update set
       name = excluded.name,
       full_name = excluded.full_name,
       default_branch = excluded.default_branch,
       is_private = excluded.is_private,
       team_id = coalesce(excluded.team_id, repositories.team_id)`,
    [id, sql.orgId, input.provider, input.providerRepoId, input.name, input.fullName,
     input.defaultBranch, input.isPrivate, input.teamId ?? null],
  );
  await sql.query(
    `insert into branches (id, org_id, repo_id, name, is_default) values ($1,$2,$3,$4,true)
     on conflict (repo_id, name) do update set is_default = true`,
    [stableId('branch', id, input.defaultBranch), sql.orgId, id, input.defaultBranch],
  );
  return {
    id, orgId: sql.orgId, provider: input.provider as Repository['provider'],
    providerRepoId: input.providerRepoId, name: input.name, fullName: input.fullName,
    defaultBranch: input.defaultBranch, isPrivate: input.isPrivate,
    teamId: input.teamId ?? null, archivedAt: null,
  };
}

export async function upsertBranch(sql: ScopedSql, repoId: string, name: string): Promise<string> {
  const id = stableId('branch', repoId, name);
  await sql.query(
    `insert into branches (id, org_id, repo_id, name, is_default) values ($1,$2,$3,$4,false)
     on conflict (repo_id, name) do nothing`,
    [id, sql.orgId, repoId, name],
  );
  return id;
}

export interface UpsertPullRequestInput {
  repoId: string;
  providerPrId: string;
  number: number;
  title?: string;
  authorUserId?: string | null;
  state?: 'open' | 'closed' | 'merged';
  isDraft?: boolean;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  readyForReviewAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commitCount?: number;
  mergeCommitSha?: string | null;
  reopened?: boolean;
}

export async function upsertPullRequest(sql: ScopedSql, input: UpsertPullRequestInput): Promise<string> {
  const id = stableId('pr', input.repoId, String(input.number));
  await sql.query(
    `insert into pull_requests (
       id, org_id, repo_id, provider_pr_id, number, title, author_user_id, state, is_draft,
       base_branch, head_branch, created_at, ready_for_review_at, merged_at, closed_at,
       additions, deletions, changed_files, commit_count, merge_commit_sha, reopened_count, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     on conflict (repo_id, number) do update set
       title           = coalesce(nullif(excluded.title, ''), pull_requests.title),
       author_user_id  = coalesce(pull_requests.author_user_id, excluded.author_user_id),
       -- 'merged' is terminal: a late 'closed' event must not undo it.
       state           = case when pull_requests.state = 'merged' then 'merged' else excluded.state end,
       is_draft        = excluded.is_draft,
       base_branch     = excluded.base_branch,
       head_branch     = excluded.head_branch,
       created_at      = least(pull_requests.created_at, excluded.created_at),
       ready_for_review_at = least(pull_requests.ready_for_review_at, excluded.ready_for_review_at),
       merged_at       = coalesce(pull_requests.merged_at, excluded.merged_at),
       closed_at       = coalesce(pull_requests.closed_at, excluded.closed_at),
       additions       = greatest(pull_requests.additions, excluded.additions),
       deletions       = greatest(pull_requests.deletions, excluded.deletions),
       changed_files   = greatest(pull_requests.changed_files, excluded.changed_files),
       commit_count    = greatest(pull_requests.commit_count, excluded.commit_count),
       merge_commit_sha = coalesce(excluded.merge_commit_sha, pull_requests.merge_commit_sha),
       reopened_count  = pull_requests.reopened_count + $21,
       updated_at      = now()`,
    [
      id, sql.orgId, input.repoId, input.providerPrId, input.number, input.title ?? '',
      input.authorUserId ?? null, input.state ?? 'open', input.isDraft ?? false,
      input.baseBranch, input.headBranch, input.createdAt,
      input.readyForReviewAt ?? (input.isDraft ? null : input.createdAt),
      input.mergedAt ?? null, input.closedAt ?? null,
      input.additions ?? 0, input.deletions ?? 0, input.changedFiles ?? 0, input.commitCount ?? 0,
      input.mergeCommitSha ?? null, input.reopened ? 1 : 0,
    ],
  );
  await upsertBranch(sql, input.repoId, input.baseBranch);
  return id;
}

export interface UpsertReviewInput {
  repoId: string;
  pullRequestId: string;
  providerReviewId: string;
  reviewerUserId: string | null;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  submittedAt: string;
  requestedAt?: string | null;
}

export async function upsertReview(sql: ScopedSql, input: UpsertReviewInput): Promise<string> {
  const id = stableId('review', input.pullRequestId, input.providerReviewId);
  await sql.query(
    `insert into reviews (id, org_id, repo_id, pull_request_id, reviewer_user_id, state, submitted_at, requested_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do update set state = excluded.state,
       requested_at = least(reviews.requested_at, excluded.requested_at)`,
    [id, sql.orgId, input.repoId, input.pullRequestId, input.reviewerUserId, input.state,
     input.submittedAt, input.requestedAt ?? null],
  );
  // Denormalise first-touch timestamps onto the PR: these drive cycle-time
  // decomposition and are read far more often than they are written.
  await sql.query(
    `update pull_requests
        set first_review_at = least(first_review_at, $2::timestamptz),
            first_approval_at = case when $3 = 'approved'
                                then least(first_approval_at, $2::timestamptz)
                                else first_approval_at end
      where id = $1`,
    [input.pullRequestId, input.submittedAt, input.state],
  );
  return id;
}

export async function upsertReviewComment(
  sql: ScopedSql,
  input: { pullRequestId: string; providerCommentId: string; reviewId?: string | null; authorUserId: string | null; createdAt: string; path?: string | null; body?: string },
): Promise<string> {
  const id = stableId('rc', input.pullRequestId, input.providerCommentId);
  await sql.query(
    `insert into review_comments (id, org_id, pull_request_id, review_id, author_user_id, created_at, path, body)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
    [id, sql.orgId, input.pullRequestId, input.reviewId ?? null, input.authorUserId, input.createdAt,
     input.path ?? null, input.body ?? ''],
  );
  return id;
}

export async function upsertCommit(
  sql: ScopedSql,
  input: { repoId: string; sha: string; authorUserId: string | null; authoredAt: string; committedAt: string; message?: string; additions?: number | null; deletions?: number | null; branch?: string | null; pullRequestId?: string | null },
): Promise<string> {
  const id = stableId('commit', input.repoId, input.sha);
  await sql.query(
    `insert into commits (id, org_id, repo_id, sha, author_user_id, authored_at, committed_at, message, additions, deletions, branch, pull_request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (repo_id, sha) do update set
       pull_request_id = coalesce(commits.pull_request_id, excluded.pull_request_id),
       additions = coalesce(excluded.additions, commits.additions),
       deletions = coalesce(excluded.deletions, commits.deletions)`,
    [id, sql.orgId, input.repoId, input.sha, input.authorUserId, input.authoredAt, input.committedAt,
     input.message ?? '', input.additions ?? null, input.deletions ?? null, input.branch ?? null,
     input.pullRequestId ?? null],
  );
  return id;
}

export async function upsertWorkflow(
  sql: ScopedSql,
  input: { repoId: string; provider: string; providerWorkflowId: string; name: string; path?: string | null },
): Promise<string> {
  const id = stableId('workflow', input.repoId, input.provider, input.providerWorkflowId);
  await sql.query(
    `insert into workflows (id, org_id, repo_id, provider, provider_workflow_id, name, path)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (repo_id, provider, provider_workflow_id) do update set name = excluded.name, path = coalesce(excluded.path, workflows.path)`,
    [id, sql.orgId, input.repoId, input.provider, input.providerWorkflowId, input.name, input.path ?? null],
  );
  return id;
}

export interface UpsertWorkflowRunInput {
  repoId: string;
  workflowId: string;
  providerRunId: string;
  runAttempt?: number;
  headSha: string;
  headBranch?: string | null;
  pullRequestId?: string | null;
  event?: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export async function upsertWorkflowRun(sql: ScopedSql, input: UpsertWorkflowRunInput): Promise<string> {
  const attempt = input.runAttempt ?? 1;
  const id = stableId('run', input.repoId, input.providerRunId, String(attempt));
  await sql.query(
    `insert into workflow_runs (id, org_id, repo_id, workflow_id, provider_run_id, run_attempt, head_sha,
        head_branch, pull_request_id, event, status, conclusion, created_at, started_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (repo_id, provider_run_id, run_attempt) do update set
       status = excluded.status,
       conclusion = coalesce(excluded.conclusion, workflow_runs.conclusion),
       pull_request_id = coalesce(excluded.pull_request_id, workflow_runs.pull_request_id),
       head_branch = coalesce(excluded.head_branch, workflow_runs.head_branch),
       started_at = least(workflow_runs.started_at, excluded.started_at),
       completed_at = coalesce(workflow_runs.completed_at, excluded.completed_at)`,
    [id, sql.orgId, input.repoId, input.workflowId, input.providerRunId, attempt, input.headSha,
     input.headBranch ?? null, input.pullRequestId ?? null, input.event ?? '', input.status,
     input.conclusion ?? null, input.createdAt, input.startedAt ?? null, input.completedAt ?? null],
  );
  return id;
}

export async function upsertDeployment(
  sql: ScopedSql,
  input: { repoId: string; providerDeploymentId: string; environment: string; isProduction: boolean; sha: string; pullRequestId?: string | null; state: string; createdAt: string; completedAt?: string | null },
): Promise<string> {
  const id = stableId('deploy', input.repoId, input.providerDeploymentId);
  await sql.query(
    `insert into deployments (id, org_id, repo_id, provider_deployment_id, environment, is_production, sha, pull_request_id, state, created_at, completed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (repo_id, provider_deployment_id) do update set
       state = excluded.state,
       completed_at = coalesce(excluded.completed_at, deployments.completed_at),
       pull_request_id = coalesce(excluded.pull_request_id, deployments.pull_request_id)`,
    [id, sql.orgId, input.repoId, input.providerDeploymentId, input.environment, input.isProduction,
     input.sha, input.pullRequestId ?? null, input.state, input.createdAt, input.completedAt ?? null],
  );
  return id;
}

export async function appendAudit(
  sql: ScopedSql,
  input: { actorUserId: string | null; action: string; resourceType: string; resourceId?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  await sql.query(
    `insert into audit_log (id, org_id, actor_user_id, action, resource_type, resource_id, detail)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [stableId('audit', sql.orgId, input.action, String(Date.now()), Math.random().toString(36)),
     sql.orgId, input.actorUserId, input.action, input.resourceType, input.resourceId ?? null,
     JSON.stringify(input.detail ?? {})],
  );
}

// ------------------------------------------------------------------ reads --

export interface RepositoryRow extends Repository {
  openPullRequests: number;
  mergedLast30d: number;
}

export async function listRepositories(sql: ScopedSql): Promise<RepositoryRow[]> {
  const rows = await sql.many<{
    id: string; provider: string; provider_repo_id: string; name: string; full_name: string;
    default_branch: string; is_private: boolean; team_id: string | null; archived_at: Date | null;
    open_prs: string; merged_30d: string;
  }>(
    `select r.id, r.provider, r.provider_repo_id, r.name, r.full_name, r.default_branch,
            r.is_private, r.team_id, r.archived_at,
            (select count(*) from pull_requests p where p.repo_id = r.id and p.state = 'open') as open_prs,
            (select count(*) from pull_requests p where p.repo_id = r.id and p.merged_at > now() - interval '30 days') as merged_30d
       from repositories r
      where r.org_id = $1
      order by r.full_name`,
    [sql.orgId],
  );
  return rows.map((r) => ({
    id: r.id, orgId: sql.orgId, provider: r.provider as Repository['provider'],
    providerRepoId: r.provider_repo_id, name: r.name, fullName: r.full_name,
    defaultBranch: r.default_branch, isPrivate: r.is_private, teamId: r.team_id,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    openPullRequests: Number(r.open_prs), mergedLast30d: Number(r.merged_30d),
  }));
}

export interface PullRequestRow extends PullRequest {
  repoFullName: string;
  authorLogin: string | null;
}

const PR_SELECT = `
  select p.id, p.repo_id, p.provider_pr_id, p.number, p.title, p.author_user_id, p.state, p.is_draft,
         p.base_branch, p.head_branch, p.created_at, p.ready_for_review_at, p.first_review_at,
         p.first_approval_at, p.merged_at, p.closed_at, p.reopened_count, p.additions, p.deletions,
         p.changed_files, p.commit_count, p.merge_commit_sha,
         r.full_name as repo_full_name, u.login as author_login
    from pull_requests p
    join repositories r on r.id = p.repo_id
    left join users u on u.id = p.author_user_id`;

interface PrRaw {
  id: string; repo_id: string; provider_pr_id: string; number: number; title: string;
  author_user_id: string | null; state: string; is_draft: boolean; base_branch: string;
  head_branch: string; created_at: Date; ready_for_review_at: Date | null; first_review_at: Date | null;
  first_approval_at: Date | null; merged_at: Date | null; closed_at: Date | null; reopened_count: number;
  additions: number; deletions: number; changed_files: number; commit_count: number;
  merge_commit_sha: string | null; repo_full_name: string; author_login: string | null;
}

const d = (x: Date | null): string | null => (x ? x.toISOString() : null);

function toPr(r: PrRaw): PullRequestRow {
  return {
    id: r.id, repoId: r.repo_id, providerPrId: r.provider_pr_id, number: r.number, title: r.title,
    authorUserId: r.author_user_id, state: r.state as PullRequest['state'], isDraft: r.is_draft,
    baseBranch: r.base_branch, headBranch: r.head_branch, createdAt: r.created_at.toISOString(),
    readyForReviewAt: d(r.ready_for_review_at), firstReviewAt: d(r.first_review_at),
    firstApprovalAt: d(r.first_approval_at), mergedAt: d(r.merged_at), closedAt: d(r.closed_at),
    reopenedCount: r.reopened_count, additions: r.additions, deletions: r.deletions,
    changedFiles: r.changed_files, commitCount: r.commit_count, mergeCommitSha: r.merge_commit_sha,
    repoFullName: r.repo_full_name, authorLogin: r.author_login,
  };
}

export async function listPullRequests(
  sql: ScopedSql,
  opts: { repoId?: string; state?: string; authorUserId?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
): Promise<PullRequestRow[]> {
  const where: string[] = ['p.org_id = $1'];
  const params: (string | number)[] = [sql.orgId];
  const add = (clause: string, value: string | number) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };
  if (opts.repoId) add('p.repo_id = ?', opts.repoId);
  if (opts.state) add('p.state = ?', opts.state);
  if (opts.authorUserId) add('p.author_user_id = ?', opts.authorUserId);
  if (opts.from) add('p.created_at >= ?::timestamptz', opts.from);
  if (opts.to) add('p.created_at < ?::timestamptz', opts.to);
  params.push(Math.min(opts.limit ?? 50, 500));
  const limitIdx = params.length;
  params.push(opts.offset ?? 0);
  const rows = await sql.many<PrRaw>(
    `${PR_SELECT} where ${where.join(' and ')} order by p.created_at desc limit $${limitIdx} offset $${params.length}`,
    params,
  );
  return rows.map(toPr);
}

export async function getPullRequest(sql: ScopedSql, id: string): Promise<PullRequestRow | null> {
  const row = await sql.one<PrRaw>(`${PR_SELECT} where p.org_id = $1 and p.id = $2`, [sql.orgId, id]);
  return row ? toPr(row) : null;
}

export async function getPullRequestByNumber(sql: ScopedSql, repoId: string, number: number): Promise<PullRequestRow | null> {
  const row = await sql.one<PrRaw>(`${PR_SELECT} where p.org_id = $1 and p.repo_id = $2 and p.number = $3`, [sql.orgId, repoId, number]);
  return row ? toPr(row) : null;
}

export async function scopeLabel(sql: ScopedSql, scopeType: ScopeType, scopeId: string): Promise<string> {
  switch (scopeType) {
    case 'org':
      return (await sql.value<string>(`select name from organizations where id = $1`, [scopeId])) ?? scopeId;
    case 'repository':
      return (await sql.value<string>(`select full_name from repositories where id = $1`, [scopeId])) ?? scopeId;
    case 'team':
      return (await sql.value<string>(`select name from teams where id = $1`, [scopeId])) ?? scopeId;
    case 'developer':
      return (await sql.value<string>(`select login from users where id = $1`, [scopeId])) ?? scopeId;
    case 'branch':
      return scopeId;
  }
}

/**
 * Organization bootstrap.
 *
 * Creating a tenant is the one write that cannot be tenant-scoped — there is
 * no org to scope to yet — so it runs unscoped, as the owner role, and is the
 * only such write in the codebase. Everything after this point is scoped.
 */
export async function provisionOrganization(db: Database, input: UpsertOrgInput): Promise<Organization> {
  const id = stableId('org', input.slug);
  const rows = await db.unscoped(async (sql) => {
    const res = await sql.query(
      `insert into organizations (id, slug, name, is_demo) values ($1,$2,$3,$4)
       on conflict (slug) do update set name = excluded.name, is_demo = excluded.is_demo
       returning id, slug, name, is_demo, created_at`,
      [id, input.slug, input.name, input.isDemo ?? false],
    );
    return res.rows as unknown as { id: string; slug: string; name: string; is_demo: boolean; created_at: Date }[];
  });
  const row = rows[0];
  if (!row) throw new Error('organization provisioning returned no row');
  return { id: row.id, slug: row.slug, name: row.name, isDemo: row.is_demo, createdAt: new Date(row.created_at).toISOString() };
}
