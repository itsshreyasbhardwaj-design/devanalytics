import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalEventSchema,
  eventIdempotencyKey,
  type CanonicalEvent,
  type RawWebhookDelivery,
  type SignatureVerification,
  type WebhookAdapter,
} from '@devanalytics/core';
import { resolveRepositoryRef } from './project.js';

/**
 * CircleCI webhook adapter.
 *
 * CircleCI is the first provider here that does not host code. That changes
 * two things that every earlier assumption depended on.
 *
 * **Its events are about someone else's repository.** The canonical event
 * carries the code host and repository path as a *reference*, and the
 * projector resolves it against an already-connected repository. Creating a
 * repository under CircleCI's name would split pull requests and CI runs
 * across two rows, and build success rate scoped to the repository a user
 * actually connected would report nothing.
 *
 * **It cannot say how long a run waited.** The workflow-completed payload
 * reports when a workflow was created and when it stopped, and nothing about
 * waiting for a runner. So `enqueuedAt` is null and CI queue time excludes
 * CircleCI runs rather than recording them as instant. Build duration is
 * unaffected, because CircleCI does report the interval it actually measures.
 */

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

const iso = (v: unknown): string | null => {
  const raw = str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** CircleCI workflow statuses that mean the workflow is over. */
const TERMINAL = new Set(['success', 'failed', 'error', 'failing', 'canceled', 'cancelled', 'unauthorized']);

function conclusionFor(status: string): string | null {
  switch (status) {
    case 'success': return 'success';
    case 'failed':
    case 'failing':
    case 'error': return 'failure';
    case 'canceled':
    case 'cancelled': return 'cancelled';
    case 'unauthorized': return 'action_required';
    default: return null;
  }
}

export class CircleCiWebhookAdapter implements WebhookAdapter {
  readonly provider = 'circleci' as const;

  deliveryId(delivery: RawWebhookDelivery): string | null {
    // CircleCI puts the event id in the body rather than a header, and reuses
    // it across retries of the same delivery.
    try {
      const body = JSON.parse(delivery.body) as Json;
      return str(body.id);
    } catch {
      return null;
    }
  }

  verifySignature(delivery: RawWebhookDelivery, secret: string): SignatureVerification {
    const header = delivery.headers['circleci-signature'];
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!header) return { valid: false, reason: 'missing_signature' };

    // The header may carry several versioned signatures, comma separated.
    const candidates = header
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('v1='))
      .map((part) => part.slice('v1='.length));
    if (candidates.length === 0) return { valid: false, reason: 'algorithm_unsupported' };

    const expected = createHmac('sha256', secret).update(delivery.body, 'utf8').digest('hex');
    const expectedBuffer = Buffer.from(expected);

    for (const candidate of candidates) {
      const presented = Buffer.from(candidate.toLowerCase());
      // A length difference is not secret information, and timingSafeEqual
      // throws on mismatched lengths.
      if (presented.length !== expectedBuffer.length) continue;
      if (timingSafeEqual(presented, expectedBuffer)) return { valid: true };
    }
    return { valid: false, reason: 'mismatch' };
  }

  normalize(delivery: RawWebhookDelivery): CanonicalEvent[] {
    const headerType = delivery.headers['circleci-event-type'];

    let body: Json;
    try {
      body = JSON.parse(delivery.body) as Json;
    } catch {
      throw new Error('webhook body is not valid JSON');
    }

    const type = str(body.type) ?? headerType;
    if (!type) throw new Error('missing CircleCI event type');

    // Ping deliveries confirm a webhook is wired up and describe no work.
    if (type === 'ping') return [];

    // Job-level events are per-stage. Only the workflow-level run is modelled,
    // matching how GitHub workflow runs and GitLab pipelines are treated: a
    // job would double count against every metric derived from runs.
    if (type === 'job-completed') return [];

    if (type !== 'workflow-completed') return [];

    return this.workflowEvents(body, delivery);
  }

  private workflowEvents(body: Json, delivery: RawWebhookDelivery): CanonicalEvent[] {
    const workflow = obj(body.workflow);
    const pipeline = obj(body.pipeline);
    const project = obj(body.project);
    if (!workflow || !pipeline || !project) return [];

    const vcs = obj(pipeline.vcs);
    const ref = resolveRepositoryRef({
      repositoryUrl: str(vcs?.target_repository_url) ?? str(vcs?.origin_repository_url),
      vcsName: str(vcs?.provider_name),
      projectSlug: str(project.slug),
    });
    // A repository on a host this platform does not model — Bitbucket — cannot
    // be attributed to anything, so the event is ignored rather than filed
    // against a guess.
    if (!ref) return [];

    const status = (str(workflow.status) ?? '').toLowerCase();
    const terminal = TERMINAL.has(status);
    if (!terminal && status !== 'running') return [];

    const workflowId = str(workflow.id);
    if (!workflowId) return [];

    const createdAt = iso(pipeline.created_at) ?? iso(workflow.created_at) ?? iso(body.happened_at);
    const startedAt = iso(workflow.created_at);
    const stoppedAt = iso(workflow.stopped_at);
    const occurredAt = iso(body.happened_at) ?? stoppedAt ?? createdAt;
    if (!createdAt || !occurredAt) return [];

    const orgSlug = str(obj(body.organization)?.name) ?? ref.fullName.split('/')[0] ?? '';
    if (!orgSlug) return [];

    const deliveryId = this.deliveryId(delivery);
    const type = terminal ? ('workflow_run.completed' as const) : ('workflow_run.started' as const);

    const event = canonicalEventSchema.parse({
      idempotencyKey: eventIdempotencyKey({
        provider: 'circleci',
        deliveryId: deliveryId ? `${deliveryId}:${type}:${workflowId}` : null,
        eventType: type,
        subjectId: workflowId,
        occurredAt,
      }),
      provider: 'circleci',
      deliveryId,
      type,
      occurredAt,
      receivedAt: delivery.receivedAt,
      orgSlug,
      repository: {
        // CircleCI has no id for the host's repository, so the path is the
        // identifier and the descriptor is a reference, not a description:
        // the default branch and visibility below are placeholders the
        // projector will not write over a connected repository.
        providerRepoId: ref.fullName,
        fullName: ref.fullName,
        name: ref.fullName.split('/').pop() ?? ref.fullName,
        defaultBranch: 'main',
        isPrivate: true,
        provider: ref.hostProvider,
        isReference: true,
      },
      // The payload identifies a commit author by name and email only, with no
      // stable id on the code host. Inventing a user from a display name would
      // create duplicate developers, and no metric derived from CI runs needs
      // an actor.
      actor: null,
      payload: {
        providerRunId: workflowId,
        // A rerun in CircleCI creates a new workflow with a new id rather than
        // a second attempt of the same one, so a rerun is a separate run.
        runAttempt: 1,
        headSha: str(vcs?.revision) ?? '',
        headBranch: str(vcs?.branch) ?? (str(vcs?.tag) ? `refs/tags/${str(vcs?.tag)}` : null),
        event: str(obj(pipeline.trigger)?.type) ?? '',
        status: terminal ? 'completed' : 'in_progress',
        conclusion: terminal ? conclusionFor(status) : null,
        createdAt,
        // CircleCI reports no runner wait. Null keeps these runs out of CI
        // queue time instead of recording them as having waited no time.
        enqueuedAt: null,
        startedAt,
        completedAt: terminal ? (stoppedAt ?? occurredAt) : null,
        workflow: {
          // CircleCI workflows are named and there are several per project,
          // which lines up with GitHub workflows and gives the CI view a
          // meaningful grouping.
          providerWorkflowId: str(workflow.name) ?? 'workflow',
          name: str(workflow.name) ?? 'workflow',
          path: '.circleci/config.yml',
        },
        // CircleCI does not report a pull request number. The projector links
        // the run through the commit it built instead.
        pullRequestNumbers: [],
        pipelineNumber: num(pipeline.number),
      },
    });

    return [event];
  }
}
