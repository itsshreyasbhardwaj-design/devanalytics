import { createHash, randomUUID } from 'node:crypto';

/** Stable, collision-resistant identifier derived from natural keys. */
export function stableId(...parts: (string | number | null | undefined)[]): string {
  const key = parts.map((p) => (p === null || p === undefined ? '\u0000' : String(p))).join('\u001f');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function newId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Deterministic idempotency key for an inbound provider event.
 *
 * Providers redeliver webhooks (GitHub retries failed deliveries, and the same
 * logical change can arrive via both webhook and backfill). The key must be a
 * function of the *event identity*, never of arrival time.
 */
export function eventIdempotencyKey(input: {
  provider: string;
  deliveryId?: string | null;
  eventType: string;
  subjectId: string;
  occurredAt: string;
}): string {
  if (input.deliveryId) return stableId(input.provider, 'delivery', input.deliveryId);
  return stableId(input.provider, input.eventType, input.subjectId, input.occurredAt);
}
