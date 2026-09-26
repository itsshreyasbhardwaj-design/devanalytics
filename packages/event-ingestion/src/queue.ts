import type { Database } from '@devanalytics/db';

/**
 * Work queue.
 *
 * The webhook handler must return in single-digit milliseconds, so it does
 * exactly three things: verify, persist, enqueue. All projection and metric
 * work happens here.
 *
 * `PostgresJobQueue` is the durable system of record — a job is committed in
 * the same transaction as the event that created it, so an event can never be
 * accepted without its work being scheduled. `RedisJobQueue` layers low-latency
 * dispatch on top of it without becoming the place jobs live, so losing Redis
 * costs latency, not data.
 */

export interface Job<T = unknown> {
  id: string;
  queue: string;
  orgId: string | null;
  payload: T;
  attempts: number;
}

export interface JobQueue {
  enqueue(input: { queue: string; orgId: string | null; payload: unknown; availableAt?: Date }): Promise<void>;
  /** Claim up to `limit` jobs, locking them against other workers. */
  claim(queue: string, limit: number, workerId: string): Promise<Job[]>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  depth(queue: string): Promise<number>;
}

export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly db: Database,
    private readonly lockTimeoutMs = 60_000,
  ) {}

  async enqueue(input: { queue: string; orgId: string | null; payload: unknown; availableAt?: Date }): Promise<void> {
    await this.db.unscoped((sql) =>
      sql.query(
        `insert into job_queue (queue, org_id, payload, available_at) values ($1,$2,$3,$4)`,
        [input.queue, input.orgId, JSON.stringify(input.payload), (input.availableAt ?? new Date()).toISOString()],
      ),
    );
  }

  async claim(queue: string, limit: number, workerId: string): Promise<Job[]> {
    const staleBefore = new Date(Date.now() - this.lockTimeoutMs).toISOString();
    return this.db.unscoped(async (sql) => {
      // `for update skip locked` is what lets several workers drain the same
      // queue without coordinating or double-processing.
      const res = await sql.query<{ id: string; queue: string; org_id: string | null; payload: unknown; attempts: number }>(
        `update job_queue
            set locked_at = now(), locked_by = $1, attempts = attempts + 1
          where id in (
            select id from job_queue
             where queue = $2
               and completed_at is null
               and available_at <= now()
               and (locked_at is null or locked_at < $3::timestamptz)
               and attempts < max_attempts
             order by available_at
             limit $4
             for update skip locked
          )
          returning id, queue, org_id, payload, attempts`,
        [workerId, queue, staleBefore, limit],
      );
      return res.rows.map((r) => ({
        id: String(r.id),
        queue: r.queue,
        orgId: r.org_id,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        attempts: Number(r.attempts),
      }));
    });
  }

  async complete(jobId: string): Promise<void> {
    await this.db.unscoped((sql) =>
      sql.query(`update job_queue set completed_at = now(), locked_at = null where id = $1`, [Number(jobId)]),
    );
  }

  async fail(jobId: string, error: string): Promise<void> {
    // Exponential backoff, capped. A job that exhausts max_attempts stops being
    // claimed and stays in the table for inspection rather than disappearing.
    await this.db.unscoped((sql) =>
      sql.query(
        `update job_queue
            set last_error = $2,
                locked_at = null,
                available_at = now() + (interval '1 second' * least(power(2, attempts), 300))
          where id = $1`,
        [Number(jobId), error.slice(0, 2000)],
      ),
    );
  }

  async depth(queue: string): Promise<number> {
    const r = await this.db.unscoped((sql) =>
      sql.query<{ n: number }>(
        `select count(*)::int as n from job_queue where queue = $1 and completed_at is null and attempts < max_attempts`,
        [queue],
      ),
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}

/** Minimal surface of the Redis client we depend on, so `ioredis` stays optional. */
export interface RedisLike {
  lpush(key: string, value: string): Promise<number>;
  rpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
}

/**
 * Redis-fronted queue.
 *
 * Writes go to Postgres first and to Redis second. A worker pops from Redis for
 * latency and falls back to claiming from Postgres, so a dropped Redis entry is
 * picked up by the database path instead of being lost.
 */
export class RedisJobQueue implements JobQueue {
  constructor(
    private readonly redis: RedisLike,
    private readonly fallback: PostgresJobQueue,
    private readonly keyPrefix = 'devanalytics:queue:',
  ) {}

  private key(queue: string): string {
    return `${this.keyPrefix}${queue}`;
  }

  async enqueue(input: { queue: string; orgId: string | null; payload: unknown; availableAt?: Date }): Promise<void> {
    await this.fallback.enqueue(input);
    if (!input.availableAt || input.availableAt <= new Date()) {
      await this.redis.lpush(this.key(input.queue), JSON.stringify({ queue: input.queue, orgId: input.orgId })).catch(() => 0);
    }
  }

  async claim(queue: string, limit: number, workerId: string): Promise<Job[]> {
    // Drain the Redis notifications so the list does not grow unbounded; the
    // authoritative claim still happens in Postgres.
    for (let i = 0; i < limit; i++) {
      const popped = await this.redis.rpop(this.key(queue)).catch(() => null);
      if (!popped) break;
    }
    return this.fallback.claim(queue, limit, workerId);
  }

  complete(jobId: string): Promise<void> {
    return this.fallback.complete(jobId);
  }
  fail(jobId: string, error: string): Promise<void> {
    return this.fallback.fail(jobId, error);
  }
  async depth(queue: string): Promise<number> {
    return this.fallback.depth(queue);
  }
}

export const QUEUES = {
  events: 'events.process',
  snapshots: 'metrics.refresh',
  anomalies: 'anomalies.detect',
  backfill: 'provider.backfill',
} as const;
