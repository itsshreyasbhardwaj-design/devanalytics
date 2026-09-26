import type { CanonicalEvent, RawWebhookDelivery } from './events.js';
import type { Provider } from './domain.js';
import type { TimeWindow } from './time.js';

/**
 * Provider interfaces.
 *
 * GitHub is the first implementation, not the model. Anything GitHub-shaped
 * (installation tokens, check runs, `X-Hub-Signature-256`) lives behind these
 * boundaries so GitLab / CircleCI / Jenkins can be added without touching the
 * ingestion pipeline, the metric engine, or the UI.
 */

export interface SignatureVerification {
  valid: boolean;
  reason?: 'missing_signature' | 'missing_secret' | 'algorithm_unsupported' | 'mismatch';
}

export interface WebhookAdapter {
  readonly provider: Provider;
  /** Constant-time verification over the raw bytes. */
  verifySignature(delivery: RawWebhookDelivery, secret: string): SignatureVerification;
  /** Returns [] for events we deliberately ignore; throws only on malformed input. */
  normalize(delivery: RawWebhookDelivery): CanonicalEvent[];
  /** Provider's own delivery identifier, if the transport supplies one. */
  deliveryId(delivery: RawWebhookDelivery): string | null;
}

export interface BackfillCursor {
  /** Opaque, provider-specific continuation token. */
  token: string | null;
  done: boolean;
}

export interface BackfillPage {
  events: CanonicalEvent[];
  cursor: BackfillCursor;
  /** Requests remaining in the provider rate-limit bucket, when known. */
  rateLimitRemaining: number | null;
}

export interface RepositorySource {
  readonly provider: Provider;
  /**
   * Historical backfill. Returns canonical events so backfill and webhooks
   * converge on the same write path (and therefore the same idempotency rules).
   */
  backfill(input: {
    orgSlug: string;
    repoFullName: string;
    window: TimeWindow;
    cursor: BackfillCursor;
    pageSize: number;
  }): Promise<BackfillPage>;
}

export interface ProviderRegistry {
  webhook(provider: string): WebhookAdapter | null;
  source(provider: string): RepositorySource | null;
  list(): Provider[];
}
