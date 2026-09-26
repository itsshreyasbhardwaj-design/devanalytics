import type { Database } from '@devanalytics/db';
import { bucketStart, type Granularity } from '@devanalytics/core';
import { QUEUES, type Job, type JobQueue } from './queue.js';
import { projectEvent } from './projector.js';

/**
 * Event worker.
 *
 * Claims events, projects them, and schedules the *narrowest* metric work the
 * event could have invalidated: the day, week and month buckets containing the
 * event's own timestamp, for the repository it touched. An event never triggers
 * a recompute of the organization's history.
 */
export interface EventJobPayload {
  eventId: string;
}

export interface SnapshotJobPayload {
  orgId: string;
  repoId: string | null;
  granularity: Granularity;
  bucketStart: string;
}

export class EventWorker {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly workerId = `worker-${process.pid}`,
  ) {}

  async drain(batchSize = 50): Promise<{ processed: number; failed: number; duplicates: number }> {
    const jobs = await this.queue.claim(QUEUES.events, batchSize, this.workerId);
    let processed = 0;
    let failed = 0;
    let duplicates = 0;

    for (const job of jobs) {
      try {
        const outcome = await this.handle(job as Job<EventJobPayload>);
        if (outcome === 'already_processed') duplicates++;
        else processed++;
        await this.queue.complete(job.id);
      } catch (err) {
        failed++;
        await this.queue.fail(job.id, (err as Error).message);
        await this.recordEventError(job.orgId, (job.payload as EventJobPayload).eventId, (err as Error).message);
      }
    }
    return { processed, failed, duplicates };
  }

  private async handle(job: Job<EventJobPayload>): Promise<'applied' | 'already_processed'> {
    const orgId = job.orgId;
    if (!orgId) throw new Error('event job has no organization');
    const { eventId } = job.payload;

    const row = await this.db.withOrg(orgId, (sql) =>
      sql.one<{ payload: unknown; processed_at: Date | null }>(
        `select payload, processed_at from events where id = $1`,
        [eventId],
      ),
    );
    if (!row) throw new Error(`event ${eventId} not found`);
    // Projection is idempotent, but skipping already-processed events keeps a
    // queue redelivery from doing pointless work.
    if (row.processed_at) return 'already_processed';

    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const result = await projectEvent(this.db, orgId, payload);

    await this.db.withOrg(orgId, (sql) =>
      sql.query(`update events set processed_at = now(), process_error = null, repo_id = $2 where id = $1`, [
        eventId,
        result.touchedRepoId,
      ]),
    );

    await this.scheduleMetricWork(orgId, result.touchedRepoId, result.occurredAt);
    return 'applied';
  }

  private async scheduleMetricWork(orgId: string, repoId: string | null, occurredAt: string): Promise<void> {
    const granularities: Granularity[] = ['day', 'week', 'month'];
    for (const granularity of granularities) {
      const payload: SnapshotJobPayload = {
        orgId,
        repoId,
        granularity,
        bucketStart: bucketStart(occurredAt, granularity).toISOString(),
      };
      // Debounced: a burst of events in the same bucket becomes one refresh a
      // few seconds later rather than one refresh per event.
      await this.queue.enqueue({
        queue: QUEUES.snapshots,
        orgId,
        payload,
        availableAt: new Date(Date.now() + 5_000),
      });
    }
  }

  private async recordEventError(orgId: string | null, eventId: string, message: string): Promise<void> {
    if (!orgId) return;
    await this.db
      .withOrg(orgId, (sql) => sql.query(`update events set process_error = $2 where id = $1`, [eventId, message.slice(0, 2000)]))
      .catch(() => undefined);
  }
}
