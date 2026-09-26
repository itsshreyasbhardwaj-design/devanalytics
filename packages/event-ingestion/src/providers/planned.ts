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

export const PLANNED_PROVIDERS: PlannedMapping[] = [CIRCLECI_MAPPING, JENKINS_MAPPING];

/**
 * GitLab was planned here and is now implemented in `@devanalytics/gitlab`.
 * Implementing it required no change to the ingestion pipeline, the metric
 * engine or the UI, which was the point of this boundary — but it did surface
 * one thing the mapping had not anticipated: GitLab's merge request webhook
 * carries no diff statistics, so `pull_requests.additions` had to become
 * nullable rather than default to zero. See migration 0008.
 */

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
