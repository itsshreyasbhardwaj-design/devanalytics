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

export const PLANNED_PROVIDERS: PlannedMapping[] = [JENKINS_MAPPING];

/**
 * GitLab and CircleCI were planned here and are now implemented in
 * `@devanalytics/gitlab` and `@devanalytics/circleci`.
 *
 * Neither required a change to the metric engine, investigations or the UI,
 * which was the point of this boundary. Each did surface one assumption the
 * canonical model had baked in while every provider was a well-behaved code
 * host:
 *
 *   GitLab  - merge request webhooks carry no diff statistics, so
 *             `pull_requests.additions` had to become nullable rather than
 *             default to zero (migration 0008).
 *   CircleCI- it does not host code, so an event has to name the repository's
 *             *host* and be resolved against it rather than creating a second
 *             repository; and it never reports a runner wait, so
 *             `workflow_runs.enqueued_at` had to become a separate nullable
 *             column rather than being inferred from the run's creation time
 *             (migration 0009).
 *
 * Both changes moved the schema in the direction the product already required:
 * unknown is not zero.
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
