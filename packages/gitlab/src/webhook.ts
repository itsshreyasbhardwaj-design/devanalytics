import { timingSafeEqual } from 'node:crypto';
import {
  canonicalEventSchema,
  eventIdempotencyKey,
  type CanonicalEvent,
  type CanonicalEventType,
  type RawWebhookDelivery,
  type SignatureVerification,
  type WebhookAdapter,
} from '@devanalytics/core';
import { addSeconds, fullShaFromCommitUrl, parseGitLabTimestamp, parseGitLabTimestampOr } from './timestamps.js';

/**
 * GitLab webhook adapter.
 *
 * Two things differ materially from GitHub and are worth stating plainly.
 *
 * **Authentication is a bearer token, not a signature.** GitLab sends the
 * configured secret back in `X-Gitlab-Token`; it does not sign the body. So a
 * valid token proves the caller knows the secret, but it does *not* prove the
 * body is unmodified in transit. GitLab offers no HMAC option for project
 * webhooks, so this is the strongest check available. Endpoints must be served
 * over TLS, and the comparison here is constant-time so the token cannot be
 * recovered a byte at a time.
 *
 * **Merge requests are identified by `iid`, not `id`.** `iid` is the
 * project-scoped number a human sees in the URL; `id` is globally unique. The
 * canonical model wants the human-facing number, so `number` comes from `iid`
 * and `providerPrId` from `id`.
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** GitLab visibility levels: 0 private, 10 internal, 20 public. */
const isPrivateProject = (project: Json): boolean => num(project.visibility_level) !== 20;

export class GitLabWebhookAdapter implements WebhookAdapter {
  readonly provider = 'gitlab' as const;

  deliveryId(delivery: RawWebhookDelivery): string | null {
    // GitLab sends a UUID per delivery, and reuses it across retries of the
    // same delivery — exactly the property idempotency needs.
    return delivery.headers['x-gitlab-event-uuid'] ?? null;
  }

  verifySignature(delivery: RawWebhookDelivery, secret: string): SignatureVerification {
    const presented = delivery.headers['x-gitlab-token'];
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!presented) return { valid: false, reason: 'missing_signature' };

    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    // A length difference is not secret information, and timingSafeEqual
    // throws on mismatched lengths.
    if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
    return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
  }

  normalize(delivery: RawWebhookDelivery): CanonicalEvent[] {
    const eventName = delivery.headers['x-gitlab-event'];
    if (!eventName) throw new Error('missing X-Gitlab-Event header');

    let body: Json;
    try {
      body = JSON.parse(delivery.body) as Json;
    } catch {
      throw new Error('webhook body is not valid JSON');
    }

    const project = obj(body.project);
    if (!project) return [];

    const pathWithNamespace = str(project.path_with_namespace) ?? '';
    // A GitLab project can sit under nested groups ("group/subgroup/project"),
    // so the organization is everything before the final segment.
    const segments = pathWithNamespace.split('/').filter(Boolean);
    const orgSlug = segments.length > 1 ? segments.slice(0, -1).join('/') : (str(project.namespace) ?? '');
    if (!orgSlug) return [];

    const repository = {
      providerRepoId: String(num(project.id) ?? ''),
      fullName: pathWithNamespace,
      name: segments[segments.length - 1] ?? (str(project.name) ?? ''),
      defaultBranch: str(project.default_branch) ?? 'main',
      isPrivate: isPrivateProject(project),
    };
    if (!repository.providerRepoId || !repository.fullName) return [];

    const deliveryId = this.deliveryId(delivery);
    const receivedAt = delivery.receivedAt;

    const build = (type: CanonicalEventType, occurredAt: string, subjectId: string, payload: Json, actor?: Json | null): CanonicalEvent =>
      canonicalEventSchema.parse({
        idempotencyKey: eventIdempotencyKey({
          provider: 'gitlab',
          // One delivery can yield several canonical events, so the key is
          // namespaced by type and subject. Retries of the same delivery reuse
          // the UUID and therefore collapse.
          deliveryId: deliveryId ? `${deliveryId}:${type}:${subjectId}` : null,
          eventType: type,
          subjectId,
          occurredAt,
        }),
        provider: 'gitlab',
        deliveryId,
        type,
        occurredAt,
        receivedAt,
        orgSlug,
        repository,
        actor: actor ? toActor(actor) : null,
        payload,
      });

    switch (eventName) {
      case 'Push Hook':
        return normalizePush(body, receivedAt, build);
      case 'Merge Request Hook':
        return normalizeMergeRequest(body, receivedAt, build);
      case 'Note Hook':
        return normalizeNote(body, receivedAt, build);
      case 'Pipeline Hook':
        return normalizePipeline(body, receivedAt, build);
      case 'Deployment Hook':
        return normalizeDeployment(body, receivedAt, build);
      case 'Tag Push Hook':
      case 'Issue Hook':
      case 'Job Hook':
      case 'Wiki Page Hook':
      case 'Release Hook':
      case 'Feature Flag Hook':
      case 'System Hook':
        // Deliberately ignored. Job Hook in particular is per-stage; only the
        // pipeline-level run is modelled, matching the documented mapping.
        return [];
      default:
        // Unknown hooks are ignored rather than fatal: GitLab adds new ones,
        // and a subscription may be broader than what we model.
        return [];
    }
  }
}

type Build = (type: CanonicalEventType, occurredAt: string, subjectId: string, payload: Json, actor?: Json | null) => CanonicalEvent;

function toActor(user: Json) {
  const username = str(user.username) ?? str(user.user_username) ?? '';
  const id = num(user.id) ?? num(user.user_id);
  return {
    providerUserId: id === null ? username : String(id),
    login: username || (str(user.name) ?? 'unknown'),
    name: str(user.name),
    // GitLab marks service accounts with a bot user type; project access
    // tokens also produce usernames of the form "project_123_bot".
    isBot: str(user.user_type) === 'project_bot' || /(^|_)bot(_|$)|^project_\d+_bot/i.test(username),
  };
}

// ------------------------------------------------------------------ push --

function normalizePush(body: Json, receivedAt: string, build: Build): CanonicalEvent[] {
  const ref = str(body.ref) ?? '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  const head = str(body.after) ?? str(body.checkout_sha) ?? '';
  const commits = arr(body.commits);
  if (commits.length === 0) return [];

  const last = commits[commits.length - 1];
  const occurredAt = parseGitLabTimestampOr(last?.timestamp, receivedAt);

  // The push payload identifies the pusher, not per-commit authors: commit
  // authors carry only a name and email, with no GitLab user id. Attributing
  // commits to the pusher matches the GitHub adapter and keeps the two
  // providers comparable, at the cost of misattributing pushed-on-behalf-of
  // commits. Backfill resolves true authors from the commits API.
  const pusher = {
    id: num(body.user_id),
    username: str(body.user_username),
    name: str(body.user_name),
    user_type: null,
  };

  return [
    build(
      'push',
      occurredAt,
      `${head}:${branch}`,
      {
        branch,
        headSha: head,
        commits: commits.map((c) => ({
          sha: str(c.id) ?? '',
          message: str(c.message) ?? str(c.title) ?? '',
          authoredAt: parseGitLabTimestampOr(c.timestamp, occurredAt),
          authorLogin: str(obj(c.author)?.name),
          authorName: str(obj(c.author)?.name),
          // GitLab's push payload lists changed file paths but no line counts.
          // Leaving these null keeps an unknown out of the size metrics rather
          // than recording a zero that would be averaged as a measurement.
          additions: null,
          deletions: null,
        })),
      },
      pusher as unknown as Json,
    ),
  ];
}

// --------------------------------------------------------- merge requests --

/**
 * The canonical pull-request payload, from a GitLab merge request.
 *
 * `additions`, `deletions` and `changedFiles` are deliberately absent: the
 * merge request hook carries no diff statistics at all. Emitting zeros would
 * make PR size report a median dragged toward zero for every GitLab
 * repository, which is exactly the class of fabricated number this platform
 * exists to avoid. Backfill fills them in from the changes API.
 */
function mergeRequestPayload(attrs: Json, receivedAt: string): Json {
  const state = str(attrs.state) ?? 'opened';
  const isDraft = attrs.draft === true || attrs.work_in_progress === true;
  const createdAt = parseGitLabTimestampOr(attrs.created_at, receivedAt);
  const updatedAt = parseGitLabTimestampOr(attrs.updated_at, createdAt);

  return {
    providerPrId: String(num(attrs.id) ?? ''),
    number: num(attrs.iid) ?? 0,
    title: str(attrs.title) ?? '',
    state: state === 'merged' ? 'merged' : state === 'closed' || state === 'locked' ? 'closed' : 'open',
    isDraft,
    baseBranch: str(attrs.target_branch) ?? 'main',
    headBranch: str(attrs.source_branch) ?? '',
    createdAt,
    // GitLab's merge request hook has no merged_at or closed_at field. The
    // closest honest value is the update timestamp of the delivery that
    // reported the transition, which is accurate to the webhook's latency.
    mergedAt: state === 'merged' ? updatedAt : null,
    closedAt: state === 'closed' || state === 'merged' ? updatedAt : null,
    mergeCommitSha: str(attrs.merge_commit_sha),
  };
}

function normalizeMergeRequest(body: Json, receivedAt: string, build: Build): CanonicalEvent[] {
  const attrs = obj(body.object_attributes);
  if (!attrs) return [];
  const action = str(attrs.action) ?? '';
  const subject = String(num(attrs.id) ?? '');
  const author = obj(body.user);
  const payload = mergeRequestPayload(attrs, receivedAt);
  const occurredAt = parseGitLabTimestampOr(attrs.updated_at, receivedAt);

  switch (action) {
    case 'open':
      return [build('pull_request.opened', payload.createdAt as string, subject, payload, author)];

    case 'reopen':
      return [build('pull_request.reopened', occurredAt, subject, payload, author)];

    case 'close':
      return [build('pull_request.closed', occurredAt, subject, payload, author)];

    case 'merge':
      return [build('pull_request.merged', occurredAt, subject, payload, author)];

    // GitLab distinguishes a single reviewer's approval from the merge request
    // reaching its full approval threshold. Both are a review being submitted;
    // only the per-user ones would be double counted, and GitLab sends exactly
    // one of the pair per user action.
    case 'approval':
    case 'approved':
      return [
        build(
          'review.submitted',
          occurredAt,
          `${subject}:approval:${num(obj(body.user)?.id) ?? 'unknown'}:${occurredAt}`,
          { providerReviewId: `approval-${subject}-${num(obj(body.user)?.id) ?? 'unknown'}-${occurredAt}`, state: 'approved', submittedAt: occurredAt, pullRequest: payload },
          author,
        ),
      ];

    case 'unapproval':
    case 'unapproved':
      return [
        build(
          'review.submitted',
          occurredAt,
          `${subject}:unapproval:${num(obj(body.user)?.id) ?? 'unknown'}:${occurredAt}`,
          { providerReviewId: `unapproval-${subject}-${num(obj(body.user)?.id) ?? 'unknown'}-${occurredAt}`, state: 'dismissed', submittedAt: occurredAt, pullRequest: payload },
          author,
        ),
      ];

    case 'update': {
      // Most updates are noise. The one that matters is a merge request
      // leaving draft, which is when its review clock starts. GitLab reports
      // that either as a `draft` change or, on older versions, as the "Draft:"
      // title prefix being removed.
      const changes = obj(body.changes);
      if (!changes) return [];
      if (leftDraft(changes)) {
        return [build('pull_request.ready_for_review', occurredAt, subject, payload, author)];
      }
      const reviewers = changes.reviewers ? obj(changes.reviewers) : null;
      if (reviewers) {
        const current = arr(reviewers.current);
        const previous = arr(reviewers.previous);
        const previousIds = new Set(previous.map((r) => num(r.id)));
        const added = current.filter((r) => !previousIds.has(num(r.id)));
        return added.map((reviewer) =>
          build(
            'pull_request.review_requested',
            occurredAt,
            `${subject}:${num(reviewer.id) ?? 'unknown'}`,
            { ...payload, requestedReviewer: toActor(reviewer) },
            author,
          ),
        );
      }
      return [];
    }

    default:
      return [];
  }
}

const DRAFT_PREFIX = /^\s*(draft:|wip:)/i;

function leftDraft(changes: Json): boolean {
  const draft = obj(changes.draft) ?? obj(changes.work_in_progress);
  if (draft) return draft.previous === true && draft.current === false;

  const title = obj(changes.title);
  if (title) {
    const previous = str(title.previous) ?? '';
    const current = str(title.current) ?? '';
    return DRAFT_PREFIX.test(previous) && !DRAFT_PREFIX.test(current);
  }
  return false;
}

// ------------------------------------------------------------------ notes --

function normalizeNote(body: Json, receivedAt: string, build: Build): CanonicalEvent[] {
  const attrs = obj(body.object_attributes);
  const mergeRequest = obj(body.merge_request);
  if (!attrs || !mergeRequest) return [];

  // System notes are GitLab's own bookkeeping ("assigned to @x", "mentioned
  // in commit abc"). They are not review activity.
  if (attrs.system === true) return [];
  if (str(attrs.noteable_type) !== 'MergeRequest') return [];

  // Only inline diff comments map onto the canonical review comment. A general
  // merge request note is discussion, whose GitHub analogue is an issue
  // comment, which this platform does not ingest either.
  if (str(attrs.type) !== 'DiffNote') return [];

  const createdAt = parseGitLabTimestampOr(attrs.created_at, receivedAt);
  const position = obj(attrs.position);

  return [
    build(
      'review_comment.created',
      createdAt,
      String(num(attrs.id) ?? ''),
      {
        providerCommentId: String(num(attrs.id) ?? ''),
        reviewId: null,
        path: str(position?.new_path) ?? str(position?.old_path),
        body: str(attrs.note) ?? '',
        createdAt,
        pullRequest: mergeRequestPayload(mergeRequest, receivedAt),
      },
      obj(body.user),
    ),
  ];
}

// -------------------------------------------------------------- pipelines --

const TERMINAL_PIPELINE_STATUSES = new Set(['success', 'failed', 'canceled', 'cancelled', 'skipped']);

function pipelineConclusion(status: string): string | null {
  switch (status) {
    case 'success': return 'success';
    case 'failed': return 'failure';
    case 'canceled':
    case 'cancelled': return 'cancelled';
    case 'skipped': return 'skipped';
    default: return null;
  }
}

function normalizePipeline(body: Json, receivedAt: string, build: Build): CanonicalEvent[] {
  const attrs = obj(body.object_attributes);
  if (!attrs) return [];

  const status = (str(attrs.status) ?? '').toLowerCase();
  const terminal = TERMINAL_PIPELINE_STATUSES.has(status);
  // Everything before "running" is scheduling noise that would land as a
  // queued run and never resolve.
  if (!terminal && status !== 'running') return [];

  const createdAt = parseGitLabTimestampOr(attrs.created_at, receivedAt);
  const finishedAt = parseGitLabTimestamp(attrs.finished_at);

  // GitLab reports queue time as a duration in seconds rather than a start
  // timestamp, so the start has to be reconstructed. Without it, CI queue time
  // is genuinely unknown and stays null rather than becoming zero.
  const queuedSeconds = num(attrs.queued_duration);
  const startedAt = queuedSeconds !== null ? addSeconds(createdAt, queuedSeconds) : null;

  const mergeRequest = obj(body.merge_request);
  const mergeRequestIid = mergeRequest ? num(mergeRequest.iid) : null;

  return [
    build(
      terminal ? 'workflow_run.completed' : 'workflow_run.started',
      terminal ? (finishedAt ?? createdAt) : createdAt,
      String(num(attrs.id) ?? ''),
      {
        providerRunId: String(num(attrs.id) ?? ''),
        // Retrying a GitLab pipeline creates a new pipeline with a new id
        // rather than a second attempt of the same one, so attempts are
        // always 1 and a retry is a separate run.
        runAttempt: 1,
        headSha: str(attrs.sha) ?? '',
        headBranch: str(attrs.ref),
        // GitLab has one pipeline definition per project, so the trigger
        // source is what GitHub's `event` field carries.
        event: str(attrs.source) ?? '',
        status: terminal ? 'completed' : 'in_progress',
        conclusion: terminal ? pipelineConclusion(status) : null,
        createdAt,
        // GitLab reports the enqueue time as the pipeline's creation time, and
        // the wait as a duration from it.
        enqueuedAt: createdAt,
        startedAt,
        completedAt: terminal ? finishedAt : null,
        workflow: {
          providerWorkflowId: 'gitlab-ci',
          name: 'GitLab CI',
          path: '.gitlab-ci.yml',
        },
        pullRequestNumbers: mergeRequestIid === null ? [] : [mergeRequestIid],
      },
      obj(body.user),
    ),
  ];
}

// ------------------------------------------------------------ deployments --

function deploymentState(status: string): string {
  switch (status.toLowerCase()) {
    case 'success': return 'success';
    case 'failed': return 'failure';
    case 'running': return 'in_progress';
    case 'canceled':
    case 'cancelled': return 'inactive';
    case 'blocked': return 'pending';
    default: return 'pending';
  }
}

const PRODUCTION_ENVIRONMENT = /^(production|prod|live)$/i;

function normalizeDeployment(body: Json, receivedAt: string, build: Build): CanonicalEvent[] {
  const environment = str(body.environment) ?? 'unknown';
  const status = str(body.status) ?? '';
  const occurredAt = parseGitLabTimestampOr(body.status_changed_at, receivedAt);
  const deploymentId = num(body.deployment_id) ?? num(body.deployable_id);
  if (deploymentId === null) return [];

  const state = deploymentState(status);

  return [
    build(
      'deployment.status_changed',
      occurredAt,
      `${deploymentId}:${status}`,
      {
        providerDeploymentId: String(deploymentId),
        environment,
        // Newer GitLab versions classify environments into tiers, which is a
        // deliberate declaration and beats guessing from the name.
        isProduction: str(body.environment_tier) === 'production' || PRODUCTION_ENVIRONMENT.test(environment),
        // The payload carries only an abbreviated sha; the full one is the
        // final segment of commit_url. Without it, this deployment could never
        // be attributed to a merge request and lead time would exclude it.
        sha: fullShaFromCommitUrl(body.commit_url, body.short_sha),
        state,
        createdAt: occurredAt,
        completedAt: state === 'success' || state === 'failure' ? occurredAt : null,
      },
      obj(body.user),
    ),
  ];
}
