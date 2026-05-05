/**
 * Per-channel registry of operator-escalated "unsafe" sessions.
 *
 * Operators trigger this with `!unsafe` in a Discord channel/thread when they
 * explicitly want Claude to have full permission for the rest of the session
 * — escape hatch for the rare case that genuinely needs bypass mode (#235).
 * `!safe` flips it back. State is in-memory only and doesn't persist across
 * gateway restarts; that's intentional — if the operator restarted the
 * gateway, they should re-confirm the escalation.
 *
 * Escalation requires explicit confirmation (#239): bare `!unsafe` only arms
 * a pending intent; the next message in the same channel must be
 * `!unsafe confirm` (within `UNSAFE_CONFIRM_WINDOW_MS`) to actually flip the
 * registry. Any other message — including a re-typed `!unsafe`, which
 * refreshes the window — clears or replaces the pending arm. This prevents a
 * single typo from granting bypass-permissions for the rest of the session.
 */

/** Default confirmation window for `!unsafe` → `!unsafe confirm` (60 seconds). */
export const UNSAFE_CONFIRM_WINDOW_MS = 60_000;

interface PendingArm {
  armedAt: number;
}

export interface UnsafeRegistry {
  /** Mark a channel/thread as unsafe-mode for the rest of the session. */
  enable(channelId: string): void;
  /** Revert a channel/thread to safe mode. No-op if not enabled. */
  disable(channelId: string): void;
  /** Whether this channel/thread is currently in unsafe mode. */
  isEnabled(channelId: string): boolean;
  /** All channels currently in unsafe mode (used by tests/diagnostics). */
  list(): string[];

  /**
   * Arm a pending escalation. The operator must follow up with
   * `confirmPending()` within the configured window. Re-arming the same
   * channel resets the window (so a user who fat-fingered the command can
   * just retype `!unsafe` without waiting for expiry).
   */
  armPending(channelId: string): void;
  /**
   * Consume a pending arm. Returns `true` only when a non-expired arm
   * existed; the arm is removed in either case so a stale entry can't
   * silently linger. The caller is responsible for calling `enable()` on
   * a successful confirmation.
   */
  confirmPending(channelId: string): boolean;
  /** Drop any pending arm for this channel. No-op if no arm is set. */
  clearPending(channelId: string): void;
  /**
   * Whether a non-expired pending arm exists for this channel. Expired
   * entries are evicted as a side effect.
   */
  hasPendingArm(channelId: string): boolean;
}

export interface UnsafeRegistryOptions {
  /** Confirmation window in ms. Defaults to {@link UNSAFE_CONFIRM_WINDOW_MS}. */
  windowMs?: number;
  /** Time source — defaults to `Date.now`. Tests can inject a controllable clock. */
  now?: () => number;
}

/**
 * Extra args appended to a session's claude invocation when unsafe mode is
 * active for that channel. Composed with the gateway defaults via
 * `composeClaudeArgs`, which strips any prior `--permission-mode <val>` and
 * `--dangerously-skip-permissions` so this escalation cleanly overrides the
 * curated `acceptEdits` floor.
 */
export const UNSAFE_MODE_EXTRA_ARGS: string[] = ['--permission-mode', 'bypassPermissions'];

export function createUnsafeRegistry(opts?: UnsafeRegistryOptions): UnsafeRegistry {
  const windowMs = opts?.windowMs ?? UNSAFE_CONFIRM_WINDOW_MS;
  const now = opts?.now ?? (() => Date.now());
  const enabled = new Set<string>();
  const pending = new Map<string, PendingArm>();

  function isFresh(armedAt: number): boolean {
    return now() - armedAt < windowMs;
  }

  return {
    enable(channelId) {
      enabled.add(channelId);
    },
    disable(channelId) {
      enabled.delete(channelId);
    },
    isEnabled(channelId) {
      return enabled.has(channelId);
    },
    list() {
      return [...enabled];
    },

    armPending(channelId) {
      pending.set(channelId, { armedAt: now() });
    },
    confirmPending(channelId) {
      const arm = pending.get(channelId);
      if (!arm) return false;
      pending.delete(channelId);
      return isFresh(arm.armedAt);
    },
    clearPending(channelId) {
      pending.delete(channelId);
    },
    hasPendingArm(channelId) {
      const arm = pending.get(channelId);
      if (!arm) return false;
      if (!isFresh(arm.armedAt)) {
        pending.delete(channelId);
        return false;
      }
      return true;
    },
  };
}
