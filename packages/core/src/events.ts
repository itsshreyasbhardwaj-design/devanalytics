import { z } from 'zod';
import type { Provider } from './domain.js';

/**
 * The canonical event model.
 *
 * Every provider (GitHub, GitLab, CircleCI, Jenkins) normalizes into exactly
 * these shapes. Nothing downstream of ingestion ever sees a provider payload.
 */
export const CANONICAL_EVENT_TYPES = [
  'push',
  'pull_request.opened',
  'pull_request.ready_for_review',
  'pull_request.closed',
  'pull_request.merged',
  'pull_request.reopened',
  'pull_request.review_requested',
  'review.submitted',
  'review_comment.created',
  'workflow_run.started',
  'workflow_run.completed',
  'deployment.created',
  'deployment.status_changed',
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export const providerSchema = z.enum(['github', 'gitlab', 'circleci', 'jenkins']);

const actorSchema = z.object({
  providerUserId: z.string(),
  login: z.string(),
  name: z.string().nullable().default(null),
  isBot: z.boolean().default(false),
});

const repoSchema = z.object({
  providerRepoId: z.string(),
  fullName: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
  /**
   * The code host, when it differs from the provider that sent the event.
   *
   * A CI-only provider such as CircleCI reports runs for a repository hosted
   * on GitHub or Bitbucket. Its events must attach to that repository rather
   * than create a second one under the CI provider's name, so they carry the
   * host here and the projector resolves against it. Omitted by code hosts,
   * for whom sender and host are the same.
   */
  provider: providerSchema.optional(),
  /**
   * True when the descriptor identifies a repository rather than describing
   * it. A CI provider knows a repository's host and path but not its default
   * branch or visibility, so those fields must not overwrite what the code
   * host already recorded.
   */
  isReference: z.boolean().optional(),
});

export const canonicalEventSchema = z.object({
  /** Idempotency key. Two events with the same key are the same event. */
  idempotencyKey: z.string().min(8),
  provider: providerSchema,
  /** Provider delivery id, when the transport has one (e.g. GitHub X-GitHub-Delivery). */
  deliveryId: z.string().nullable().default(null),
  type: z.enum(CANONICAL_EVENT_TYPES),
  /** When the thing happened, per the provider. Never our receive time. */
  occurredAt: z.string().datetime({ offset: true }),
  /** When we received it. Used for ingestion-lag observability only. */
  receivedAt: z.string().datetime({ offset: true }),
  orgSlug: z.string(),
  repository: repoSchema,
  actor: actorSchema.nullable().default(null),
  /** Normalized entity payload; shape depends on `type`. Validated per-handler. */
  payload: z.record(z.unknown()),
});

export type CanonicalEvent = z.infer<typeof canonicalEventSchema>;

export interface RawWebhookDelivery {
  provider: Provider;
  /** Raw request body exactly as received — signatures are computed over bytes, not JSON. */
  body: string;
  headers: Record<string, string | undefined>;
  receivedAt: string;
}

export type IngestOutcome =
  | { status: 'accepted'; eventId: string; idempotencyKey: string }
  | { status: 'duplicate'; eventId: string; idempotencyKey: string }
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: 'invalid_signature' | 'malformed' | 'unknown_provider'; detail?: string };
