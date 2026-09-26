import type { CanonicalEventType, RawWebhookDelivery, SignatureVerification, WebhookAdapter } from '@devanalytics/core';

/**
 * Providers that the architecture supports but that are not implemented yet.
 *
 * These are here so the shape of the work is explicit and reviewable rather
 * than implied. Each records the exact mapping from its native events to the
 * canonical model; implementing one means filling in `normalize` and
 * `verifySignature` against that table, with no changes anywhere else in the
 * system.
 *
 * They throw rather than returning empty results, so a half-wired provider
 * fails loudly at the boundary instead of quietly ingesting nothing.
 */

export class ProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(
      `The ${provider} adapter is not implemented. Its event mapping is documented in packages/event-ingestion/src/providers/planned.ts.`,
    );
    this.name = 'ProviderNotImplementedError';
  }
}

export interface PlannedMapping {
  provider: string;
  signature: string;
  /** native event -> canonical event */
  events: Record<string, CanonicalEventType | null>;
  notes: string[];
}

export const GITLAB_MAPPING: PlannedMapping = {
  provider: 'gitlab',
  signature: 'X-Gitlab-Token, compared in constant time against the stored endpoint secret (GitLab sends the token itself, not an HMAC).',
  events: {
    'Push Hook': 'push',
    'Merge Request Hook/open': 'pull_request.opened',
    'Merge Request Hook/merge': 'pull_request.merged',
    'Merge Request Hook/close': 'pull_request.closed',
    'Merge Request Hook/reopen': 'pull_request.reopened',
    'Note Hook (DiffNote)': 'review_comment.created',
    'Merge Request Hook/approved': 'review.submitted',
    'Pipeline Hook/running': 'workflow_run.started',
    'Pipeline Hook/success|failed': 'workflow_run.completed',
    'Deployment Hook': 'deployment.status_changed',
  },
  notes: [
    'GitLab approvals are a separate resource from notes; both map onto review.submitted with different states.',
    'Pipeline "stages" have no GitHub analogue and are not modelled; only the pipeline-level run is ingested.',
    'Draft status is the "Draft:" title prefix, so ready_for_review_at must be derived from the title change in the MR hook.',
  ],
};

export const CIRCLECI_MAPPING: PlannedMapping = {
  provider: 'circleci',
  signature: 'circleci-signature header, v1=<hmac-sha256 of the raw body>.',
  events: {
    'workflow-completed': 'workflow_run.completed',
    'job-completed': null,
  },
  notes: [
    'CircleCI webhooks carry no queue timestamp, so ci_queue_time is unavailable for CircleCI-only repositories and must return insufficient_data rather than zero.',
    'CircleCI is CI-only: pull request and deployment events still come from the code host.',
  ],
};

export const JENKINS_MAPPING: PlannedMapping = {
  provider: 'jenkins',
  signature: 'No native signing. Endpoints require a bearer token over TLS and an allowlist of controller IPs.',
  events: {
    'build.started': 'workflow_run.started',
    'build.completed': 'workflow_run.completed',
  },
  notes: [
    'Jenkins build numbers are per-job, so provider_run_id must be namespaced as "<job>#<build>" to stay unique within a repository.',
    'Queue time is available from the build "queueDurationMillis" field via the API, not from the webhook payload.',
  ],
};

export const PLANNED_PROVIDERS: PlannedMapping[] = [GITLAB_MAPPING, CIRCLECI_MAPPING, JENKINS_MAPPING];

export class PlannedWebhookAdapter implements WebhookAdapter {
  constructor(readonly mapping: PlannedMapping) {}

  get provider() {
    return this.mapping.provider as WebhookAdapter['provider'];
  }

  verifySignature(_delivery: RawWebhookDelivery, _secret: string): SignatureVerification {
    throw new ProviderNotImplementedError(this.mapping.provider);
  }

  normalize(_delivery: RawWebhookDelivery): never {
    throw new ProviderNotImplementedError(this.mapping.provider);
  }

  deliveryId(_delivery: RawWebhookDelivery): string | null {
    return null;
  }
}
