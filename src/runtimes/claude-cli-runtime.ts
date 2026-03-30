import { runClaude } from '../claude-cli.js';
import type { AgentRuntime, SpawnOpts } from '../agent-runtime.js';
import type { ClaudeResult } from '../claude-cli.js';

/**
 * Default AgentRuntime that delegates to the Claude CLI via child_process spawn.
 * This preserves the existing behaviour — a direct, non-persistent subprocess call.
 *
 * Phase 2 will add a `persistent: true` mode backed by tmux (#98).
 */
export class ClaudeCliRuntime implements AgentRuntime {
  readonly name = 'claude-cli';
  readonly canResume = false;

  spawn(opts: SpawnOpts): Promise<ClaudeResult> {
    return runClaude(
      opts.cwd,
      opts.baseArgs,
      opts.prompt,
      opts.sessionId,
      opts.systemPrompt,
      opts.timeoutMs,
    );
  }

  async listOrphanedSessions(): Promise<string[]> {
    return [];
  }

  async reattach(_sessionId: string): Promise<ClaudeResult> {
    throw new Error('ClaudeCliRuntime does not support session reattachment');
  }
}
