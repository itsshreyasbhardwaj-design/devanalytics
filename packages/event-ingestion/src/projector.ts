import {
  canonicalEventSchema,
  type CanonicalEvent,
} from '@devanalytics/core';
import {
  upsertCommit,
  upsertDeployment,
  upsertPullRequest,
  upsertRepository,
  upsertReview,
  upsertReviewComment,
  upsertUser,
  upsertWorkflow,
  upsertWorkflowRun,
  type Database,
  type ScopedSql,
} from '@devanalytics/db';

/**
 * Projection.
 *
 * Canonical events are the log; the domain tables are a projection of it.
 * Projection is idempotent and order-independent: replaying the whole log
 * produces the same tables, and an event that arrives late cannot undo a
 * later fact (see the `least`/`greatest`/`coalesce` merge rules in the
 * repository layer).
 */

export interface ProjectionResult {
  touchedRepoId: string | null;
  occurredAt: string;
  applied: boolean;
}

type Json = Record<string, unknown>;

const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export async function projectEvent(db: Database, orgId: string, raw: unknown): Promise<ProjectionResult> {
  const event = canonicalEventSchema.parse(raw);
  return db.withOrg(orgId, async (sql) => {
    const repo = await upsertRepository(sql, {
      provider: event.provider,
      providerRepoId: event.repository.providerRepoId,
      name: event.repository.name,
      fullName: event.repository.fullName,
      defaultBranch: event.repository.defaultBranch,
      isPrivate: event.repository.isPrivate,
    });

    const actorId = event.actor
      ? (
          await upsertUser(sql, {
            provider: event.provider,
            providerUserId: event.actor.providerUserId,
            login: event.actor.login,
            name: event.actor.name,
            isBot: event.actor.isBot,
          })
        ).id
      : null;

    await apply(sql, event, repo.id, actorId);
    return { touchedRepoId: repo.id, occurredAt: event.occurredAt, applied: true };
  });
}

async function apply(sql: ScopedSql, event: CanonicalEvent, repoId: string, actorId: string | null): Promise<void> {
  const p = event.payload as Json;

  switch (event.type) {
    case 'push': {
      const commits = Array.isArray(p.commits) ? (p.commits as Json[]) : [];
      for (const c of commits) {
        const sha = s(c.sha);
        if (!sha) continue;
        const authoredAt = s(c.authoredAt) ?? event.occurredAt;
        await upsertCommit(sql, {
          repoId, sha, authorUserId: actorId, authoredAt, committedAt: authoredAt,
          message: s(c.message) ?? '', additions: n(c.additions), deletions: n(c.deletions),
          branch: s(p.branch),
        });
      }
      return;
    }

    case 'pull_request.opened':
    case 'pull_request.ready_for_review':
    case 'pull_request.reopened':
    case 'pull_request.closed':
    case 'pull_request.merged':
    case 'pull_request.review_requested': {
      await upsertPr(sql, repoId, p, actorId, {
        readyNow: event.type === 'pull_request.ready_for_review' ? event.occurredAt : null,
        reopened: event.type === 'pull_request.reopened',
      });
      return;
    }

    case 'review.submitted': {
      const prPayload = (p.pullRequest ?? {}) as Json;
      const prId = await upsertPr(sql, repoId, prPayload, null, { readyNow: null, reopened: false });
      await upsertReview(sql, {
        repoId,
        pullRequestId: prId,
        providerReviewId: s(p.providerReviewId) ?? event.idempotencyKey,
        reviewerUserId: actorId,
        state: (s(p.state) ?? 'commented') as 'approved' | 'changes_requested' | 'commented' | 'dismissed',
        submittedAt: s(p.submittedAt) ?? event.occurredAt,
        requestedAt: s(p.requestedAt),
      });
      return;
    }

    case 'review_comment.created': {
      const prPayload = (p.pullRequest ?? {}) as Json;
      const prId = await upsertPr(sql, repoId, prPayload, null, { readyNow: null, reopened: false });
      await upsertReviewComment(sql, {
        pullRequestId: prId,
        providerCommentId: s(p.providerCommentId) ?? event.idempotencyKey,
        authorUserId: actorId,
        createdAt: s(p.createdAt) ?? event.occurredAt,
        path: s(p.path),
        body: s(p.body) ?? '',
      });
      return;
    }

    case 'workflow_run.started':
    case 'workflow_run.completed': {
      const wf = (p.workflow ?? {}) as Json;
      const workflowId = await upsertWorkflow(sql, {
        repoId, provider: event.provider,
        providerWorkflowId: s(wf.providerWorkflowId) ?? 'unknown',
        name: s(wf.name) ?? 'workflow',
        path: s(wf.path),
      });
      // Link the run to a pull request when the provider told us which one.
      const prNumbers = Array.isArray(p.pullRequestNumbers) ? (p.pullRequestNumbers as number[]) : [];
      let pullRequestId: string | null = null;
      if (prNumbers.length > 0) {
        pullRequestId = await sql.value<string>(
          `select id from pull_requests where repo_id = $1 and number = $2`,
          [repoId, prNumbers[0] as number],
        );
      }
      await upsertWorkflowRun(sql, {
        repoId, workflowId,
        providerRunId: s(p.providerRunId) ?? event.idempotencyKey,
        runAttempt: n(p.runAttempt) ?? 1,
        headSha: s(p.headSha) ?? '',
        headBranch: s(p.headBranch),
        pullRequestId,
        event: s(p.event) ?? '',
        status: (s(p.status) ?? 'queued') as 'queued' | 'in_progress' | 'completed',
        conclusion: s(p.conclusion),
        createdAt: s(p.createdAt) ?? event.occurredAt,
        startedAt: s(p.startedAt),
        completedAt: s(p.completedAt),
      });
      return;
    }

    case 'deployment.created':
    case 'deployment.status_changed': {
      // Attribute the deployment to the pull request whose merge commit it
      // shipped. Without that link, lead time for changes is not computable,
      // and the metric reports the exclusion rather than guessing.
      const sha = s(p.sha) ?? '';
      const pullRequestId = sha
        ? await sql.value<string>(
            `select id from pull_requests where repo_id = $1 and (merge_commit_sha = $2
               or id in (select pull_request_id from commits where repo_id = $1 and sha = $2 and pull_request_id is not null))
             limit 1`,
            [repoId, sha],
          )
        : null;
      await upsertDeployment(sql, {
        repoId,
        providerDeploymentId: s(p.providerDeploymentId) ?? event.idempotencyKey,
        environment: s(p.environment) ?? 'unknown',
        isProduction: p.isProduction === true,
        sha,
        pullRequestId,
        state: s(p.state) ?? 'pending',
        createdAt: s(p.createdAt) ?? event.occurredAt,
        completedAt: s(p.completedAt),
      });
      return;
    }
  }
}

async function upsertPr(
  sql: ScopedSql,
  repoId: string,
  p: Json,
  actorId: string | null,
  opts: { readyNow: string | null; reopened: boolean },
): Promise<string> {
  const number = n(p.number);
  if (number === null) throw new Error('pull request payload has no number');
  const isDraft = p.isDraft === true;
  const createdAt = s(p.createdAt) ?? new Date().toISOString();
  return upsertPullRequest(sql, {
    repoId,
    providerPrId: s(p.providerPrId) ?? String(number),
    number,
    title: s(p.title) ?? '',
    authorUserId: actorId,
    state: (s(p.state) ?? 'open') as 'open' | 'closed' | 'merged',
    isDraft,
    baseBranch: s(p.baseBranch) ?? 'main',
    headBranch: s(p.headBranch) ?? '',
    createdAt,
    // A PR that opens ready for review starts its clock immediately; a draft
    // starts it when it is marked ready.
    readyForReviewAt: opts.readyNow ?? (isDraft ? null : createdAt),
    mergedAt: s(p.mergedAt),
    closedAt: s(p.closedAt),
    additions: n(p.additions) ?? 0,
    deletions: n(p.deletions) ?? 0,
    changedFiles: n(p.changedFiles) ?? 0,
    commitCount: n(p.commitCount) ?? 0,
    mergeCommitSha: s(p.mergeCommitSha),
    reopened: opts.reopened,
  });
}
