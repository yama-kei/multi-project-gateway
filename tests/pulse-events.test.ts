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
});
