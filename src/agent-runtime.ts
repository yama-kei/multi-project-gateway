import type { ClaudeResult } from './claude-cli.js';

/** Options passed to AgentRuntime.spawn(). */
export interface SpawnOpts {
  cwd: string;
  baseArgs: string[];
  prompt: string;
  sessionId: string | undefined;
  systemPrompt?: string;
  timeoutMs?: number;
  /** Project key used by the session manager (e.g. threadId or threadId:agentName).
   *  Used by tmux runtime to name sessions so they can be matched on recovery. */
  projectKey?: string;
}

/**
 * Abstraction over how agent processes are launched and managed.
 *
 * Phase 1: Only `spawn()` is used by the session manager.
 * Phase 2 will fill in `listOrphanedSessions()` and `reattach()` for
 * tmux-based persistence (see #98, #87).
 */
export interface AgentRuntime {
  /** Human-readable name for this runtime (e.g. "claude-cli"). */
  readonly name: string;

  /** Whether this runtime supports resuming orphaned sessions. */
  readonly canResume: boolean;

  /** Execute a prompt and return the result. */
  spawn(opts: SpawnOpts): Promise<ClaudeResult>;

  /** Discover sessions that survived a gateway restart. */
  listOrphanedSessions(): Promise<string[]>;

  /** Re-attach to an orphaned session and resume output capture. */
  reattach(sessionId: string): Promise<ClaudeResult>;

  /** Clean up resources (tmux session, temp files) for a finished session. */
  cleanup?(sessionKey: string): void;
}
