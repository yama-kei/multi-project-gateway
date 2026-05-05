import { describe, it, expect } from 'vitest';
import { createUnsafeRegistry, UNSAFE_MODE_EXTRA_ARGS, UNSAFE_CONFIRM_WINDOW_MS } from '../src/unsafe-mode.js';

describe('createUnsafeRegistry', () => {
  it('starts with no enabled channels', () => {
    const reg = createUnsafeRegistry();
    expect(reg.isEnabled('chan-1')).toBe(false);
    expect(reg.list()).toEqual([]);
  });

  it('enables a channel', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(true);
  });

  it('disables a previously enabled channel', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.disable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(false);
  });

  it('isolates channels from each other', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(true);
    expect(reg.isEnabled('chan-2')).toBe(false);
  });

  it('list() returns all enabled channels', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.enable('chan-2');
    expect(reg.list().sort()).toEqual(['chan-1', 'chan-2']);
  });

  it('disabling a non-enabled channel is a no-op', () => {
    const reg = createUnsafeRegistry();
    expect(() => reg.disable('chan-x')).not.toThrow();
    expect(reg.isEnabled('chan-x')).toBe(false);
  });

  it('enabling the same channel twice is idempotent', () => {
    const reg = createUnsafeRegistry();
    reg.enable('chan-1');
    reg.enable('chan-1');
    expect(reg.list()).toEqual(['chan-1']);
  });
});

describe('UNSAFE_MODE_EXTRA_ARGS', () => {
  it('uses --permission-mode bypassPermissions to escalate the session', () => {
    expect(UNSAFE_MODE_EXTRA_ARGS).toEqual(['--permission-mode', 'bypassPermissions']);
  });
});

describe('UNSAFE_CONFIRM_WINDOW_MS', () => {
  it('defaults to 60 seconds', () => {
    expect(UNSAFE_CONFIRM_WINDOW_MS).toBe(60_000);
  });
});

describe('createUnsafeRegistry — pending arm / confirmation flow (#239)', () => {
  // A controllable clock makes time-based behavior deterministic without
  // pulling vitest's fake-timer infrastructure into a registry that has no
  // other timer use.
  function clock(start = 1_000_000) {
    let t = start;
    return {
      now: () => t,
      advance(ms: number) { t += ms; },
    };
  }

  it('starts with no pending arms', () => {
    const reg = createUnsafeRegistry();
    expect(reg.hasPendingArm('chan-1')).toBe(false);
  });

  it('armPending records a pending arm visible via hasPendingArm', () => {
    const reg = createUnsafeRegistry();
    reg.armPending('chan-1');
    expect(reg.hasPendingArm('chan-1')).toBe(true);
  });

  it('armPending does NOT enable the channel by itself', () => {
    const reg = createUnsafeRegistry();
    reg.armPending('chan-1');
    expect(reg.isEnabled('chan-1')).toBe(false);
  });

  it('confirmPending returns true and consumes the pending arm when fresh', () => {
    const reg = createUnsafeRegistry();
    reg.armPending('chan-1');
    expect(reg.confirmPending('chan-1')).toBe(true);
    expect(reg.hasPendingArm('chan-1')).toBe(false);
  });

  it('confirmPending returns false when no arm exists', () => {
    const reg = createUnsafeRegistry();
    expect(reg.confirmPending('chan-1')).toBe(false);
  });

  it('confirmPending returns false (and consumes) once the window expires', () => {
    const c = clock();
    const reg = createUnsafeRegistry({ now: c.now, windowMs: 60_000 });
    reg.armPending('chan-1');
    c.advance(60_001);
    expect(reg.confirmPending('chan-1')).toBe(false);
    // Stale entry is also evicted so the next call sees a clean slate.
    expect(reg.hasPendingArm('chan-1')).toBe(false);
  });

  it('hasPendingArm auto-evicts expired arms', () => {
    const c = clock();
    const reg = createUnsafeRegistry({ now: c.now, windowMs: 1_000 });
    reg.armPending('chan-1');
    expect(reg.hasPendingArm('chan-1')).toBe(true);
    c.advance(1_500);
    expect(reg.hasPendingArm('chan-1')).toBe(false);
  });

  it('re-arming the same channel refreshes the window', () => {
    const c = clock();
    const reg = createUnsafeRegistry({ now: c.now, windowMs: 1_000 });
    reg.armPending('chan-1');
    c.advance(900);                  // 100ms left on the original arm
    reg.armPending('chan-1');         // refresh
    c.advance(900);                  // would have expired the original; refreshed arm has 100ms left
    expect(reg.hasPendingArm('chan-1')).toBe(true);
    expect(reg.confirmPending('chan-1')).toBe(true);
  });

  it('clearPending drops a pending arm without confirming', () => {
    const reg = createUnsafeRegistry();
    reg.armPending('chan-1');
    reg.clearPending('chan-1');
    expect(reg.hasPendingArm('chan-1')).toBe(false);
    expect(reg.confirmPending('chan-1')).toBe(false);
  });

  it('clearPending is a no-op when no arm exists', () => {
    const reg = createUnsafeRegistry();
    expect(() => reg.clearPending('chan-x')).not.toThrow();
  });

  it('pending arms are isolated per channel', () => {
    const reg = createUnsafeRegistry();
    reg.armPending('chan-1');
    expect(reg.hasPendingArm('chan-1')).toBe(true);
    expect(reg.hasPendingArm('chan-2')).toBe(false);
    expect(reg.confirmPending('chan-2')).toBe(false);
    expect(reg.hasPendingArm('chan-1')).toBe(true); // unaffected
  });
});
