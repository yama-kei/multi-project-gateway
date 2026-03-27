import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ClaudeUsage } from './claude-cli.js';

export interface PulseEmitter {
  sessionStart(sessionId: string, projectKey: string, projectDir: string, opts?: { agentName?: string; triggerSource?: string }): void;
  sessionEnd(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionIdle(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionResume(sessionId: string, projectKey: string, projectDir: string, idleDurationMs: number): void;
  messageRouted(sessionId: string, projectKey: string, projectDir: string, opts?: { agentTarget?: string; queueDepth?: number }): void;
  messageCompleted(sessionId: string, projectKey: string, projectDir: string, usage: ClaudeUsage, opts?: { agentTarget?: string }): void;
}

const DEFAULT_PATH = join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

function baseEvent(eventType: string, sessionId: string, projectKey: string, projectDir: string) {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    event_type: eventType,
    session_id: sessionId,
    project_key: projectKey,
    project_dir: projectDir,
  };
}

export function createPulseEmitter(filePath?: string): PulseEmitter {
  const target = filePath ?? DEFAULT_PATH;
  let dirCreated = false;

  function emit(event: Record<string, unknown>): void {
    try {
      if (!dirCreated) {
        mkdirSync(dirname(target), { recursive: true });
        dirCreated = true;
      }
      appendFileSync(target, JSON.stringify(event) + '\n');
    } catch {
      // Fire-and-forget: never crash the gateway for event logging
    }
  }

  return {
    sessionStart(sessionId, projectKey, projectDir, opts) {
      emit({
        ...baseEvent('session_start', sessionId, projectKey, projectDir),
        agent_name: opts?.agentName,
        trigger_source: opts?.triggerSource ?? 'unknown',
      });
    },

    sessionEnd(sessionId, projectKey, projectDir, durationMs, messageCount) {
      emit({
        ...baseEvent('session_end', sessionId, projectKey, projectDir),
        duration_ms: durationMs,
        message_count: messageCount,
      });
    },

    sessionIdle(sessionId, projectKey, projectDir, durationMs, messageCount) {
      emit({
        ...baseEvent('session_idle', sessionId, projectKey, projectDir),
        duration_ms: durationMs,
        message_count: messageCount,
      });
    },

    sessionResume(sessionId, projectKey, projectDir, idleDurationMs) {
      emit({
        ...baseEvent('session_resume', sessionId, projectKey, projectDir),
        idle_duration_ms: idleDurationMs,
      });
    },

    messageRouted(sessionId, projectKey, projectDir, opts) {
      emit({
        ...baseEvent('message_routed', sessionId, projectKey, projectDir),
        agent_target: opts?.agentTarget,
        queue_depth: opts?.queueDepth ?? 0,
      });
    },

    messageCompleted(sessionId, projectKey, projectDir, usage, opts) {
      emit({
        ...baseEvent('message_completed', sessionId, projectKey, projectDir),
        agent_target: opts?.agentTarget,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        total_cost_usd: usage.total_cost_usd,
        duration_ms: usage.duration_ms,
        duration_api_ms: usage.duration_api_ms,
        num_turns: usage.num_turns,
        model: usage.model,
      });
    },
  };
}
