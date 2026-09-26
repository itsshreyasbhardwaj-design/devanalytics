import { sha256Hex, decryptSecret, type Database } from '@devanalytics/db';
import {
  stableId,
  type CanonicalEvent,
  type IngestOutcome,
  type RawWebhookDelivery,
  type WebhookAdapter,
} from '@devanalytics/core';
import { QUEUES, type JobQueue } from './queue.js';

/**
 * Webhook ingestion.
 *
 * The request path is deliberately short and does no analytics:
 *
 *   verify signature -> record delivery -> normalize -> idempotent insert -> enqueue
 *
 * Everything expensive happens in the worker. A webhook handler that computed
 * metrics inline would time out under a backfill or a monorepo's CI volume,
 * and GitHub would start disabling the hook.
 */

export interface EndpointRecord {
  id: string;
  orgId: string;
  provider: string;
  secret: string;
}

export interface IngestionDeps {
  db: Database;
  queue: JobQueue;
  adapters: Map<string, WebhookAdapter>;
  /** Overridable for tests; defaults to reading and decrypting from the database. */
  lookupEndpoint?: (endpointId: string) => Promise<EndpointRecord | null>;
}

export interface ReceiveInput extends RawWebhookDelivery {
  endpointId: string;
}

export class IngestionService {
  constructor(private readonly deps: IngestionDeps) {}

  async receive(input: ReceiveInput): Promise<IngestOutcome> {
    const adapter = this.deps.adapters.get(input.provider);
    if (!adapter) return { status: 'rejected', reason: 'unknown_provider' };

    const endpoint = await (this.deps.lookupEndpoint ?? ((id) => this.loadEndpoint(id)))(input.endpointId);
    // An unknown endpoint id and a bad signature return the same result, so the
    // endpoint id cannot be probed for existence.
    if (!endpoint || endpoint.provider !== input.provider) {
      await this.recordDelivery(input, null, false, 401);
      return { status: 'rejected', reason: 'invalid_signature', detail: 'unknown endpoint or bad signature' };
    }

    const verification = adapter.verifySignature(input, endpoint.secret);
    if (!verification.valid) {
      await this.recordDelivery(input, endpoint.orgId, false, 401);
      return { status: 'rejected', reason: 'invalid_signature', detail: verification.reason };
    }

    let events: CanonicalEvent[];
    try {
      events = adapter.normalize(input);
    } catch (err) {
      await this.recordDelivery(input, endpoint.orgId, true, 400);
      return { status: 'rejected', reason: 'malformed', detail: (err as Error).message };
    }

    await this.recordDelivery(input, endpoint.orgId, true, 202);
    if (events.length === 0) {
      return { status: 'ignored', reason: 'no canonical event for this webhook' };
    }

    let outcome: IngestOutcome = { status: 'ignored', reason: 'no canonical event for this webhook' };
    for (const event of events) {
      outcome = await this.persist(endpoint.orgId, event);
    }
    return outcome;
  }

  /**
   * Idempotent write.
   *
   * The event row and its queue job are committed together, so an accepted
   * event always has scheduled work, and a duplicate never schedules a second
   * one — which is what makes provider redeliveries safe.
   */
  async persist(orgId: string, event: CanonicalEvent): Promise<IngestOutcome> {
    const eventId = stableId('event', event.idempotencyKey);
    const inserted = await this.deps.db.withOrg(orgId, async (sql) => {
      const res = await sql.query<{ id: string }>(
        `insert into events (id, org_id, provider, type, idempotency_key, delivery_id, occurred_at, received_at, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (idempotency_key) do nothing
         returning id`,
        [eventId, orgId, event.provider, event.type, event.idempotencyKey, event.deliveryId,
         event.occurredAt, event.receivedAt, JSON.stringify(event)],
      );
      return res.rows.length > 0;
    });

    if (!inserted) return { status: 'duplicate', eventId, idempotencyKey: event.idempotencyKey };

    await this.deps.queue.enqueue({ queue: QUEUES.events, orgId, payload: { eventId } });
    return { status: 'accepted', eventId, idempotencyKey: event.idempotencyKey };
  }

  private async loadEndpoint(endpointId: string): Promise<EndpointRecord | null> {
    // Endpoint lookup precedes authentication, so it runs unscoped by
    // necessity; it selects exactly one row by primary key and returns only
    // the fields ingestion needs.
    const row = await this.deps.db.unscoped(async (sql) => {
      const res = await sql.query<{ id: string; org_id: string; provider: string; secret_enc: string }>(
        `select id, org_id, provider, secret_enc from webhook_endpoints where id = $1 and revoked_at is null`,
        [endpointId],
      );
      return res.rows[0] ?? null;
    });
    if (!row) return null;
    try {
      return { id: row.id, orgId: row.org_id, provider: row.provider, secret: decryptSecret(row.secret_enc) };
    } catch {
      return null;
    }
  }

  private async recordDelivery(input: ReceiveInput, orgId: string | null, signatureValid: boolean, httpStatus: number): Promise<void> {
    const id = stableId('delivery', input.endpointId, input.headers['x-github-delivery'] ?? sha256Hex(input.body), input.receivedAt);
    await this.deps.db.unscoped((sql) =>
      sql.query(
        `insert into webhook_deliveries (id, org_id, provider, delivery_id, event_header, signature_valid, body_sha256, body, received_at, http_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (id) do nothing`,
        [
          id, orgId, input.provider,
          input.headers['x-github-delivery'] ?? null,
          input.headers['x-github-event'] ?? null,
          signatureValid, sha256Hex(input.body),
          // Bodies of rejected deliveries are not stored: an unauthenticated
          // caller must not be able to write arbitrary content into our tables.
          signatureValid ? input.body.slice(0, 200_000) : null,
          input.receivedAt, httpStatus,
        ],
      ),
    );
  }
}
