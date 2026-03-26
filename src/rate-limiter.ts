/**
 * Simple in-memory per-user rate limiter.
 * Tracks message timestamps per user and enforces a max-messages-per-minute limit.
 */

const WINDOW_MS = 60_000; // 1 minute window
const CLEANUP_INTERVAL_MS = 5 * 60_000; // clean up every 5 minutes

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the user can send another message (only set when blocked). */
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(userId: string, limit: number): RateLimitResult;
  dispose(): void;
}

export function createRateLimiter(): RateLimiter {
  const timestamps = new Map<string, number[]>();

  function pruneUser(userId: string, now: number): number[] {
    const ts = timestamps.get(userId);
    if (!ts) return [];
    const valid = ts.filter((t) => now - t < WINDOW_MS);
    if (valid.length === 0) {
      timestamps.delete(userId);
      return [];
    }
    timestamps.set(userId, valid);
    return valid;
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const userId of timestamps.keys()) {
      pruneUser(userId, now);
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't keep Node alive just for cleanup
  if (cleanupTimer.unref) cleanupTimer.unref();

  return {
    check(userId: string, limit: number): RateLimitResult {
      const now = Date.now();
      const valid = pruneUser(userId, now);

      if (valid.length >= limit) {
        // Find the oldest timestamp in the window to calculate retry-after
        const oldest = valid[0];
        const retryAfterMs = WINDOW_MS - (now - oldest);
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        };
      }

      // Record this message
      if (!timestamps.has(userId)) {
        timestamps.set(userId, [now]);
      } else {
        timestamps.get(userId)!.push(now);
      }

      return { allowed: true };
    },

    dispose() {
      clearInterval(cleanupTimer);
      timestamps.clear();
    },
  };
}
