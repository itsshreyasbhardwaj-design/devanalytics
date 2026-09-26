/**
 * Worker.
 *
 * Drains three queues:
 *   events.process   - project canonical events into domain tables
 *   metrics.refresh  - recompute the snapshot buckets those events touched
 *   anomalies.detect - run detection on a schedule
 *
 * Nothing here is on a request path, so it can take as long as it needs; the
 * webhook handler stays fast because all of this happens out of band.
 */
import { MS_PER_DAY, type Granularity, type ScopeType } from '@devanalytics/core';
import { QUEUES, type SnapshotJobPayload } from '@devanalytics/event-ingestion';
import { persistDetections, runDetection } from '@devanalytics/investigations';
import { refreshBucket } from '@devanalytics/metrics';
import { createRuntime } from '@devanalytics/runtime';

const POLL_INTERVAL_MS = Number(process.env.DEVANALYTICS_WORKER_POLL_MS ?? 2000);
const DETECTION_INTERVAL_MS = Number(process.env.DEVANALYTICS_DETECTION_INTERVAL_MS ?? 15 * 60 * 1000);
const WORKER_ID = `worker-${process.pid}`;

const runtime = await createRuntime();
let running = true;
let lastDetection = 0;

const log = (message: string, extra: Record<string, unknown> = {}) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), worker: WORKER_ID, message, ...extra })}\n`);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('shutting down', { signal });
    running = false;
  });
}

async function drainSnapshots(): Promise<number> {
  const jobs = await runtime.queue.claim(QUEUES.snapshots, 25, WORKER_ID);
  // Several events in the same bucket produce identical refresh jobs; collapse
  // them so a busy repository is recomputed once, not once per event.
  const seen = new Set<string>();
  let refreshed = 0;

  for (const job of jobs) {
    const payload = job.payload as SnapshotJobPayload;
    const key = `${payload.orgId}:${payload.repoId ?? 'org'}:${payload.granularity}:${payload.bucketStart}`;
    if (seen.has(key)) {
      await runtime.queue.complete(job.id);
      continue;
    }
    seen.add(key);

    try {
      const scopes: { scopeType: ScopeType; scopeId: string }[] = [{ scopeType: 'org', scopeId: payload.orgId }];
      if (payload.repoId) scopes.push({ scopeType: 'repository', scopeId: payload.repoId });
      await refreshBucket(runtime.db, runtime.engine, {
        orgId: payload.orgId,
        scopes,
        granularity: payload.granularity as Granularity,
        bucketStart: payload.bucketStart,
      });
      await runtime.queue.complete(job.id);
      refreshed++;
    } catch (err) {
      await runtime.queue.fail(job.id, (err as Error).message);
      log('snapshot refresh failed', { error: (err as Error).message });
    }
  }
  return refreshed;
}

async function runScheduledDetection(): Promise<void> {
  if (Date.now() - lastDetection < DETECTION_INTERVAL_MS) return;
  lastDetection = Date.now();

  const orgs = await runtime.db.unscoped((sql) => sql.query<{ id: string }>(`select id from organizations`));
  for (const org of orgs.rows) {
    try {
      const repos = await runtime.db.withOrg(org.id, (sql) =>
        sql.many<{ id: string }>(`select id from repositories where archived_at is null`), 'readonly');
      const detections = await runDetection(runtime.db, runtime.engine, {
        orgId: org.id,
        scopes: [
          { scopeType: 'org', scopeId: org.id },
          ...repos.map((r) => ({ scopeType: 'repository' as const, scopeId: r.id })),
        ],
        granularity: 'day',
        baselineBuckets: 30,
      });
      const saved = await persistDetections(runtime.db, org.id, detections);
      if (detections.length > 0) {
        log('detection run', { orgId: org.id, examined: detections.length, anomalies: saved });
      }
    } catch (err) {
      log('detection failed', { orgId: org.id, error: (err as Error).message });
    }
  }
}

log('worker started', {
  pollMs: POLL_INTERVAL_MS,
  detectionIntervalMs: DETECTION_INTERVAL_MS,
  database: runtime.config.databaseUrl ? 'postgres' : 'embedded',
  queue: runtime.config.redisUrl ? 'redis+postgres' : 'postgres',
});

while (running) {
  try {
    const events = await runtime.worker.drain(50);
    const snapshots = await drainSnapshots();
    await runScheduledDetection();

    if (events.processed > 0 || events.failed > 0 || snapshots > 0) {
      log('drained', { ...events, snapshots });
    }
    if (events.processed === 0 && snapshots === 0) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } catch (err) {
    log('loop error', { error: (err as Error).message });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

await runtime.close();
log('worker stopped');
void MS_PER_DAY;
