import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalEventSchema,
  eventIdempotencyKey,
  type CanonicalEvent,
  type CanonicalEventType,
  type RawWebhookDelivery,
  type SignatureVerification,
  type WebhookAdapter,
} from '@devanalytics/core';

/**
 * GitHub webhook adapter.
 *
 * Signature verification happens over the raw request bytes, before the body
 * is parsed. Parsing first and re-serialising would change whitespace and key
 * order, and the HMAC would no longer be over what GitHub actually signed.
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numStr = (v: unknown): string | null =>
  typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

export class GitHubWebhookAdapter implements WebhookAdapter {
  readonly provider = 'github' as const;

  deliveryId(delivery: RawWebhookDelivery): string | null {
    return delivery.headers['x-github-delivery'] ?? null;
  }

  verifySignature(delivery: RawWebhookDelivery, secret: string): SignatureVerification {
    const header = delivery.headers['x-hub-signature-256'];
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!header) return { valid: false, reason: 'missing_signature' };
    if (!header.startsWith('sha256=')) return { valid: false, reason: 'algorithm_unsupported' };

    const expected = `sha256=${createHmac('sha256', secret).update(delivery.body, 'utf8').digest('hex')}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    // Length check first: timingSafeEqual throws on mismatched lengths, and a
    // length difference is not secret information.
    if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
    return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
  }

  normalize(delivery: RawWebhookDelivery): CanonicalEvent[] {
    const eventName = delivery.headers['x-github-event'];
    if (!eventName) throw new Error('missing X-GitHub-Event header');

    let body: Json;
    try {
      body = JSON.parse(delivery.body) as Json;
    } catch {
      throw new Error('webhook body is not valid JSON');
    }

    const repo = obj(body.repository);
    if (!repo) return [];
    const owner = obj(repo.owner);
    const orgSlug = str(obj(body.organization)?.login) ?? str(owner?.login) ?? str(repo.full_name)?.split('/')[0] ?? null;
    if (!orgSlug) return [];

    const repository = {
      providerRepoId: numStr(repo.id) ?? '',
      fullName: str(repo.full_name) ?? '',
      name: str(repo.name) ?? '',
      defaultBranch: str(repo.default_branch) ?? 'main',
      isPrivate: repo.private === true,
    };

    const deliveryId = this.deliveryId(delivery);
    const receivedAt = delivery.receivedAt;

    const build = (type: CanonicalEventType, occurredAt: string, subjectId: string, payload: Json, actorSource?: Json | null): CanonicalEvent =>
      canonicalEventSchema.parse({
        idempotencyKey: eventIdempotencyKey({
          provider: 'github',
          // Redeliveries reuse the delivery id, so they collapse. A single
          // delivery that yields several canonical events disambiguates with
          // the event type and subject.
          deliveryId: deliveryId ? `${deliveryId}:${type}:${subjectId}` : null,
          eventType: type,
          subjectId,
          occurredAt,
        }),
        provider: 'github',
        deliveryId,
        type,
        occurredAt: new Date(occurredAt).toISOString(),
        receivedAt,
        orgSlug,
        repository,
        actor: actorSource ? toActor(actorSource) : null,
        payload,
      });

    switch (eventName) {
      case 'push':
        return normalizePush(body, build);
      case 'pull_request':
        return normalizePullRequest(body, build);
      case 'pull_request_review':
        return normalizeReview(body, build);
      case 'pull_request_review_comment':
        return normalizeReviewComment(body, build);
      case 'workflow_run':
        return normalizeWorkflowRun(body, build);
      case 'deployment':
      case 'deployment_status':
        return normalizeDeployment(eventName, body, build);
      case 'ping':
        return [];
      default:
        // Unknown event types are ignored, not an error: GitHub adds new ones
        // and a subscription may be broader than what we model.
        return [];
    }
  }
}

function toActor(u: Json) {
  return {
    providerUserId: numStr(u.id) ?? '',
    login: str(u.login) ?? 'unknown',
    name: str(u.name),
    isBot: str(u.type) === 'Bot' || (str(u.login) ?? '').endsWith('[bot]'),
  };
}

type Build = (type: CanonicalEventType, occurredAt: string, subjectId: string, payload: Json, actor?: Json | null) => CanonicalEvent;

function normalizePush(body: Json, build: Build): CanonicalEvent[] {
  const commits = Array.isArray(body.commits) ? (body.commits as Json[]) : [];
  const ref = str(body.ref) ?? '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const head = str(body.after) ?? '';
  const pusher = obj(body.sender);
  const occurredAt = str(obj(commits[commits.length - 1])?.timestamp) ?? new Date().toISOString();
  return [
    build('push', occurredAt, `${head}:${branch}`, {
      branch,
      headSha: head,
      commits: commits.map((c) => ({
        sha: str(c.id) ?? '',
        message: str(c.message) ?? '',
        authoredAt: str(c.timestamp) ?? occurredAt,
        authorLogin: str(obj(c.author)?.username),
        authorName: str(obj(c.author)?.name),
        additions: null,
        deletions: null,
      })),
    }, pusher),
  ];
}

function prPayload(pr: Json): Json {
  return {
    providerPrId: numStr(pr.id) ?? '',
    number: typeof pr.number === 'number' ? pr.number : Number(pr.number),
    title: str(pr.title) ?? '',
    state: pr.merged_at ? 'merged' : str(pr.state) === 'closed' ? 'closed' : 'open',
    isDraft: pr.draft === true,
    baseBranch: str(obj(pr.base)?.ref) ?? 'main',
    headBranch: str(obj(pr.head)?.ref) ?? '',
    createdAt: str(pr.created_at),
    mergedAt: str(pr.merged_at),
    closedAt: str(pr.closed_at),
    additions: typeof pr.additions === 'number' ? pr.additions : 0,
    deletions: typeof pr.deletions === 'number' ? pr.deletions : 0,
    changedFiles: typeof pr.changed_files === 'number' ? pr.changed_files : 0,
    commitCount: typeof pr.commits === 'number' ? pr.commits : 0,
    mergeCommitSha: str(pr.merge_commit_sha),
  };
}

function normalizePullRequest(body: Json, build: Build): CanonicalEvent[] {
  const pr = obj(body.pull_request);
  if (!pr) return [];
  const action = str(body.action) ?? '';
  const subject = numStr(pr.id) ?? '';
  const author = obj(pr.user);
  const payload = prPayload(pr);

  switch (action) {
    case 'opened':
      return [build('pull_request.opened', str(pr.created_at) ?? new Date().toISOString(), subject, payload, author)];
    case 'ready_for_review':
      return [build('pull_request.ready_for_review', str(pr.updated_at) ?? new Date().toISOString(), subject, payload, author)];
    case 'reopened':
      return [build('pull_request.reopened', str(pr.updated_at) ?? new Date().toISOString(), subject, payload, author)];
    case 'review_requested': {
      const reviewer = obj(body.requested_reviewer);
      return [
        build(
          'pull_request.review_requested',
          str(pr.updated_at) ?? new Date().toISOString(),
          `${subject}:${numStr(reviewer?.id) ?? 'team'}`,
          { ...payload, requestedReviewer: reviewer ? toActor(reviewer) : null },
          author,
        ),
      ];
    }
    case 'closed':
      // A merge is a distinct fact from a close, and only a merge ends cycle time.
      return [
        build(
          pr.merged_at ? 'pull_request.merged' : 'pull_request.closed',
          str(pr.merged_at) ?? str(pr.closed_at) ?? new Date().toISOString(),
          subject,
          payload,
          author,
        ),
      ];
    case 'synchronize':
    case 'edited':
    case 'labeled':
    case 'unlabeled':
    case 'assigned':
    case 'unassigned':
      return [];
    default:
      return [];
  }
}

function normalizeReview(body: Json, build: Build): CanonicalEvent[] {
  const review = obj(body.review);
  const pr = obj(body.pull_request);
  if (!review || !pr || str(body.action) !== 'submitted') return [];
  const state = (str(review.state) ?? '').toLowerCase();
  const mapped =
    state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes_requested' : state === 'dismissed' ? 'dismissed' : 'commented';
  return [
    build(
      'review.submitted',
      str(review.submitted_at) ?? new Date().toISOString(),
      numStr(review.id) ?? '',
      {
        providerReviewId: numStr(review.id) ?? '',
        state: mapped,
        submittedAt: str(review.submitted_at),
        pullRequest: prPayload(pr),
      },
      obj(review.user),
    ),
  ];
}

function normalizeReviewComment(body: Json, build: Build): CanonicalEvent[] {
  const comment = obj(body.comment);
  const pr = obj(body.pull_request);
  if (!comment || !pr || str(body.action) !== 'created') return [];
  return [
    build(
      'review_comment.created',
      str(comment.created_at) ?? new Date().toISOString(),
      numStr(comment.id) ?? '',
      {
        providerCommentId: numStr(comment.id) ?? '',
        reviewId: numStr(comment.pull_request_review_id),
        path: str(comment.path),
        body: str(comment.body) ?? '',
        createdAt: str(comment.created_at),
        pullRequest: prPayload(pr),
      },
      obj(comment.user),
    ),
  ];
}

function normalizeWorkflowRun(body: Json, build: Build): CanonicalEvent[] {
  const run = obj(body.workflow_run);
  if (!run) return [];
  const action = str(body.action) ?? '';
  if (action !== 'requested' && action !== 'in_progress' && action !== 'completed') return [];
  const workflow = obj(body.workflow);
  const prs = Array.isArray(run.pull_requests) ? (run.pull_requests as Json[]) : [];
  const payload: Json = {
    providerRunId: numStr(run.id) ?? '',
    runAttempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
    headSha: str(run.head_sha) ?? '',
    headBranch: str(run.head_branch),
    event: str(run.event) ?? '',
    status: action === 'completed' ? 'completed' : action === 'in_progress' ? 'in_progress' : 'queued',
    conclusion: str(run.conclusion),
    createdAt: str(run.created_at),
    // GitHub reports the enqueue time as the run's creation time.
    enqueuedAt: str(run.created_at),
    startedAt: str(run.run_started_at),
    completedAt: action === 'completed' ? (str(run.updated_at) ?? null) : null,
    workflow: {
      providerWorkflowId: numStr(run.workflow_id) ?? numStr(workflow?.id) ?? '',
      name: str(run.name) ?? str(workflow?.name) ?? 'workflow',
      path: str(workflow?.path) ?? str(run.path),
    },
    pullRequestNumbers: prs.map((p) => (typeof p.number === 'number' ? p.number : Number(p.number))).filter((n) => Number.isFinite(n)),
  };
  const type: CanonicalEventType = action === 'completed' ? 'workflow_run.completed' : 'workflow_run.started';
  const occurredAt = action === 'completed' ? (str(run.updated_at) ?? new Date().toISOString()) : (str(run.created_at) ?? new Date().toISOString());
  return [build(type, occurredAt, `${numStr(run.id)}:${payload.runAttempt}`, payload, obj(run.actor) ?? obj(body.sender))];
}

function normalizeDeployment(eventName: string, body: Json, build: Build): CanonicalEvent[] {
  const deployment = obj(body.deployment);
  if (!deployment) return [];
  const status = obj(body.deployment_status);
  const environment = str(deployment.environment) ?? 'unknown';
  const payload: Json = {
    providerDeploymentId: numStr(deployment.id) ?? '',
    environment,
    // Treat the conventional production environment names as production and
    // let operators override per repository in settings.
    isProduction: /^(production|prod|live)$/i.test(environment) || deployment.production_environment === true,
    sha: str(deployment.sha) ?? '',
    state: status ? mapDeploymentState(str(status.state)) : 'pending',
    createdAt: str(deployment.created_at),
    completedAt: status ? (str(status.updated_at) ?? str(status.created_at)) : null,
    pullRequestNumber: null,
  };
  if (eventName === 'deployment') {
    return [build('deployment.created', str(deployment.created_at) ?? new Date().toISOString(), numStr(deployment.id) ?? '', payload, obj(body.sender))];
  }
  const occurredAt = str(status?.updated_at) ?? str(status?.created_at) ?? new Date().toISOString();
  return [
    build('deployment.status_changed', occurredAt, `${numStr(deployment.id)}:${numStr(status?.id) ?? occurredAt}`, payload, obj(body.sender)),
  ];
}

function mapDeploymentState(state: string | null): string {
  switch (state) {
    case 'success': return 'success';
    case 'failure': return 'failure';
    case 'error': return 'error';
    case 'in_progress': return 'in_progress';
    case 'inactive': return 'inactive';
    default: return 'pending';
  }
}
