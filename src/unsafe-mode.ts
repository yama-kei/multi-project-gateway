/**
 * Per-channel registry of operator-escalated "unsafe" sessions.
 *
 * Operators trigger this with `!unsafe` in a Discord channel/thread when they
 * explicitly want Claude to have full permission for the rest of the session
 * — escape hatch for the rare case that genuinely needs bypass mode (#235).
 * `!safe` flips it back. State is in-memory only and doesn't persist across
 * gateway restarts; that's intentional — if the operator restarted the
 * gateway, they should re-confirm the escalation.
 */
export interface UnsafeRegistry {
  /** Mark a channel/thread as unsafe-mode for the rest of the session. */
  enable(channelId: string): void;
  /** Revert a channel/thread to safe mode. No-op if not enabled. */
  disable(channelId: string): void;
  /** Whether this channel/thread is currently in unsafe mode. */
  isEnabled(channelId: string): boolean;
  /** All channels currently in unsafe mode (used by tests/diagnostics). */
  list(): string[];
}

/**
 * Extra args appended to a session's claude invocation when unsafe mode is
 * active for that channel. Composed with the gateway defaults via
 * `composeClaudeArgs`, which strips any prior `--permission-mode <val>` and
 * `--dangerously-skip-permissions` so this escalation cleanly overrides the
 * curated `acceptEdits` floor.
 */
export const UNSAFE_MODE_EXTRA_ARGS: string[] = ['--permission-mode', 'bypassPermissions'];

export function createUnsafeRegistry(): UnsafeRegistry {
  const enabled = new Set<string>();
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
  };
}
