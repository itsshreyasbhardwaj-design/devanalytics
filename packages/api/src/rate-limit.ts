import { RateLimitedError } from '@devanalytics/core';

/**
 * Rate limiting.
 *
 * A token bucket per principal. The in-memory store is correct for a single
 * process; a multi-instance deployment supplies the Redis-backed store so the
 * limit is shared. Limits are per principal rather than per IP, because the
 * expensive callers here are authenticated API tokens and MCP agents, not
 * anonymous traffic.
 */

export interface RateLimitStore {
  consume(key: string, cost: number, capacity: number, refillPerSecond: number): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async consume(key: string, cost: number, capacity: number, refillPerSecond: number) {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      this.buckets.set(key, bucket);
      const deficit = cost - bucket.tokens;
      return { allowed: false, retryAfterSeconds: Math.ceil(deficit / refillPerSecond), remaining: Math.floor(bucket.tokens) };
    }
    bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
  }
}

export interface RateLimitPolicy {
  capacity: number;
  refillPerSecond: number;
  /** Cost of one request. AI and export endpoints cost more than a metric read. */
  cost: number;
}

export const POLICIES: Record<string, RateLimitPolicy> = {
  read: { capacity: 120, refillPerSecond: 2, cost: 1 },
  write: { capacity: 30, refillPerSecond: 0.5, cost: 1 },
  export: { capacity: 10, refillPerSecond: 0.1, cost: 1 },
  ai: { capacity: 20, refillPerSecond: 0.05, cost: 1 },
  webhook: { capacity: 1000, refillPerSecond: 50, cost: 1 },
};

export class RateLimiter {
  constructor(private readonly store: RateLimitStore = new MemoryRateLimitStore()) {}

  async check(key: string, policyName: keyof typeof POLICIES | string): Promise<{ remaining: number }> {
    const policy = POLICIES[policyName] ?? POLICIES.read;
    if (!policy) return { remaining: 0 };
    const result = await this.store.consume(key, policy.cost, policy.capacity, policy.refillPerSecond);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
    return { remaining: result.remaining };
  }
}
