import { describe, it, expect } from 'vitest';
import { MemoryRateLimitStore, POLICIES, RateLimiter } from '@devanalytics/api';
import { RateLimitedError } from '@devanalytics/core';

describe('rate limiting', () => {
  it('allows a burst up to the policy capacity, then refuses', async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    const capacity = POLICIES.read?.capacity as number;
    for (let i = 0; i < capacity; i++) {
      await expect(limiter.check('p1', 'read')).resolves.toBeDefined();
    }
    await expect(limiter.check('p1', 'read')).rejects.toThrow(RateLimitedError);
  });

  it('reports how long to wait', async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    for (let i = 0; i < (POLICIES.export?.capacity as number); i++) await limiter.check('p1', 'export');
    await expect(limiter.check('p1', 'export')).rejects.toMatchObject({
      code: 'rate_limited',
      detail: { retryAfterSeconds: expect.any(Number) },
    });
  });

  it('keeps a separate budget per policy', async () => {
    // Regression: buckets were keyed on the principal alone, so browsing the
    // dashboard drained the AI allowance, and because capacity is applied on
    // refill the smallest policy's capacity became the ceiling for all of them.
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    const aiCapacity = POLICIES.ai?.capacity as number;

    for (let i = 0; i < (POLICIES.read?.capacity as number); i++) {
      await limiter.check('p1', 'read');
    }
    await expect(limiter.check('p1', 'read')).rejects.toThrow(RateLimitedError);

    // The AI budget is untouched by all that reading.
    for (let i = 0; i < aiCapacity; i++) {
      await expect(limiter.check('p1', 'ai')).resolves.toBeDefined();
    }
    await expect(limiter.check('p1', 'ai')).rejects.toThrow(RateLimitedError);
  });

  it('keeps a separate budget per principal', async () => {
    const limiter = new RateLimiter(new MemoryRateLimitStore());
    for (let i = 0; i < (POLICIES.read?.capacity as number); i++) await limiter.check('p1', 'read');
    await expect(limiter.check('p1', 'read')).rejects.toThrow(RateLimitedError);
    await expect(limiter.check('p2', 'read')).resolves.toBeDefined();
  });

  it('refills over time', async () => {
    const store = new MemoryRateLimitStore();
    // Capacity 2, one token per second.
    await store.consume('k', 2, 2, 1);
    const empty = await store.consume('k', 1, 2, 1);
    expect(empty.allowed).toBe(false);
    expect(empty.retryAfterSeconds).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1100));
    const afterRefill = await store.consume('k', 1, 2, 1);
    expect(afterRefill.allowed).toBe(true);
  });
});
