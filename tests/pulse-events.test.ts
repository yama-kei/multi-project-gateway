import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPulseEmitter } from '../src/pulse-events.js';

describe('PulseEmitter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pulse-test-'));
    filePath = join(dir, 'events', 'mpg-sessions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits session_start event with correct schema', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { agentName: 'engineer', triggerSource: 'discord' });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.schema_version).toBe(1);
    expect(event.event_type).toBe('session_start');
    expect(event.session_id).toBe('sess-1');
    expect(event.project_key).toBe('project-a');
    expect(event.project_dir).toBe('/tmp/project');
    expect(event.agent_name).toBe('engineer');
    expect(event.trigger_source).toBe('discord');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('emits session_end event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionEnd('sess-1', 'project-a', '/tmp/project', 60000, 5);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_end');
    expect(event.duration_ms).toBe(60000);
    expect(event.message_count).toBe(5);
  });

  it('emits session_idle event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionIdle('sess-1', 'project-a', '/tmp/project', 30000, 3);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_idle');
    expect(event.duration_ms).toBe(30000);
    expect(event.message_count).toBe(3);
  });

  it('emits session_resume event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionResume('sess-1', 'project-a', '/tmp/project', 120000);

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('session_resume');
    expect(event.idle_duration_ms).toBe(120000);
  });

  it('emits message_routed event', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.messageRouted('sess-1', 'project-a', '/tmp/project', { agentTarget: 'pm', queueDepth: 2 });

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.event_type).toBe('message_routed');
    expect(event.agent_target).toBe('pm');
    expect(event.queue_depth).toBe(2);
  });

  it('appends multiple events to same file', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });
    emitter.messageRouted('sess-1', 'project-a', '/tmp/project', { queueDepth: 0 });

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_type).toBe('session_start');
    expect(JSON.parse(lines[1]).event_type).toBe('message_routed');
  });

  it('creates parent directories if they do not exist', () => {
    const deepPath = join(dir, 'a', 'b', 'c', 'events.jsonl');
    const emitter = createPulseEmitter(deepPath);
    emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });

    const content = readFileSync(deepPath, 'utf-8').trim();
    expect(JSON.parse(content).event_type).toBe('session_start');
  });

  it('does not throw on write failure (fire-and-forget)', () => {
    const emitter = createPulseEmitter('/dev/null/impossible/path.jsonl');
    expect(() => {
      emitter.sessionStart('sess-1', 'project-a', '/tmp/project', { triggerSource: 'discord' });
    }).not.toThrow();
  });

  it('emits message_completed event with usage payload', () => {
    const emitter = createPulseEmitter(filePath);
    emitter.messageCompleted('sess-1', 'project-a', '/tmp/project', {
      input_tokens: 15000,
      output_tokens: 3200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 8000,
      total_cost_usd: 0.042,
      duration_ms: 45000,
      duration_api_ms: 38000,
      num_turns: 12,
      model: 'claude-sonnet-4-20250514',
    }, { agentTarget: 'engineer' });

    const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(event.schema_version).toBe(1);
    expect(event.event_type).toBe('message_completed');
    expect(event.session_id).toBe('sess-1');
    expect(event.project_key).toBe('project-a');
    expect(event.project_dir).toBe('/tmp/project');
    expect(event.agent_target).toBe('engineer');
    expect(event.input_tokens).toBe(15000);
    expect(event.output_tokens).toBe(3200);
    expect(event.cache_creation_input_tokens).toBe(5000);
    expect(event.cache_read_input_tokens).toBe(8000);
    expect(event.total_cost_usd).toBe(0.042);
    expect(event.duration_ms).toBe(45000);
    expect(event.duration_api_ms).toBe(38000);
    expect(event.num_turns).toBe(12);
    expect(event.model).toBe('claude-sonnet-4-20250514');
  });
});
