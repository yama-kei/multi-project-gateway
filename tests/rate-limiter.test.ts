import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRateLimiter } from '../src/rate-limiter.js';

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows messages under the limit', () => {
    const limiter = createRateLimiter();
    const r1 = limiter.check('user-1', 3);
    expect(r1.allowed).toBe(true);

    const r2 = limiter.check('user-1', 3);
    expect(r2.allowed).toBe(true);

    const r3 = limiter.check('user-1', 3);
    expect(r3.allowed).toBe(true);
    limiter.dispose();
  });

  it('blocks messages over the limit', () => {
    const limiter = createRateLimiter();
    limiter.check('user-1', 2);
    limiter.check('user-1', 2);
    const r3 = limiter.check('user-1', 2);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
    limiter.dispose();
  });

  it('tracks users independently', () => {
    const limiter = createRateLimiter();
    limiter.check('user-1', 1);
    const r1 = limiter.check('user-1', 1);
    expect(r1.allowed).toBe(false);

    const r2 = limiter.check('user-2', 1);
    expect(r2.allowed).toBe(true);
    limiter.dispose();
  });

  it('allows messages after the window expires', () => {
    const limiter = createRateLimiter();
    const now = Date.now();

    // Mock Date.now to simulate time passing
    vi.spyOn(Date, 'now').mockReturnValue(now);
    limiter.check('user-1', 1);

    const r1 = limiter.check('user-1', 1);
    expect(r1.allowed).toBe(false);

    // Advance time past the 60s window
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const r2 = limiter.check('user-1', 1);
    expect(r2.allowed).toBe(true);
    limiter.dispose();
  });

  it('returns correct retryAfterSeconds', () => {
    const limiter = createRateLimiter();
    const now = Date.now();

    vi.spyOn(Date, 'now').mockReturnValue(now);
    limiter.check('user-1', 1);

    // 10 seconds later, try again
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    const result = limiter.check('user-1', 1);
    expect(result.allowed).toBe(false);
    // Should be ~50 seconds remaining (60 - 10)
    expect(result.retryAfterSeconds).toBe(50);
    limiter.dispose();
  });
});
