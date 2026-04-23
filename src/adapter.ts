import type { ClaudeResult } from './claude-cli.js';

/**
 * Platform-agnostic chat adapter interface.
 * Each chat platform (Discord, Slack, etc.) implements this contract.
 */
export interface ChannelAdapter {
  /** Connect to the chat platform and start listening for messages. */
  start(): Promise<void>;
  /** Disconnect and clean up resources. */
  stop(): void;
  /** Return the current connection status as a human-readable string. */
  getStatus(): string;
  /** Return the guild/server ID of the connected server, or null if not available or not applicable. */
  getGuildId?(): string | null;
  /** Notify a thread/channel that orphan recovery is starting (typing indicator + interim message). Optional. */
  notifyRecoveryStart?(projectKey: string): void;
  /** Notify a thread/channel that orphan recovery failed — clean up any side-effects from notifyRecoveryStart. Optional. */
  notifyRecoveryFailed?(projectKey: string, error: Error): void;
  /** Deliver a recovered orphaned session result back to the originating thread/channel. */
  deliverOrphanResult(projectKey: string, result: ClaudeResult): Promise<void>;
}
