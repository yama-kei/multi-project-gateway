import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActivityEngine } from '../src/activity-engine.js';

function makeEvent(overrides: Record<string, unknown>) {
  return JSON.stringify({
    schema_version: 1,
    timestamp: new Date().toISOString(),
    session_id: 'sess-1',
    project_key: 'project-a',
    project_dir: '/tmp/a',
    ...overrides,
  });
}

function writeEvents(filePath: string, events: string[]) {
  writeFileSync(filePath, events.join('\n') + '\n');
}

describe('ActivityEngine', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'activity-test-'));
    filePath = join(dir, 'mpg-sessions.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('computeSummary', () => {
    it('returns zero values for missing file', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      const s = engine.computeSummary('7d');
      expect(s.total_cost_usd).toBe(0);
      expect(s.total_sessions).toBe(0);
      expect(s.total_messages).toBe(0);
      expect(s.total_input_tokens).toBe(0);
      expect(s.total_output_tokens).toBe(0);
      expect(s.avg_session_duration_ms).toBe(0);
    });

    it('aggregates across event types', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start' }),
        makeEvent({ event_type: 'message_completed', input_tokens: 10000, output_tokens: 2000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 8000, output_tokens: 1500, total_cost_usd: 0.02 }),
        makeEvent({ event_type: 'session_end', duration_ms: 60000, message_count: 2 }),
      ]);
      const engine = createActivityEngine(filePath);
      const s = engine.computeSummary('7d');
      expect(s.total_sessions).toBe(1);
      expect(s.total_messages).toBe(2);
      expect(s.total_cost_usd).toBeCloseTo(0.05);
      expect(s.total_input_tokens).toBe(18000);
      expect(s.total_output_tokens).toBe(3500);
      expect(s.avg_session_duration_ms).toBe(60000);
    });

    it('filters by time range', () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', timestamp: old }),
        makeEvent({ event_type: 'message_completed', timestamp: old, input_tokens: 10000, output_tokens: 1000, total_cost_usd: 0.05 }),
        makeEvent({ event_type: 'session_start', timestamp: recent }),
        makeEvent({ event_type: 'message_completed', timestamp: recent, input_tokens: 5000, output_tokens: 500, total_cost_usd: 0.02 }),
      ]);
      const engine = createActivityEngine(filePath);
      const s7d = engine.computeSummary('7d');
      expect(s7d.total_sessions).toBe(1);
      expect(s7d.total_messages).toBe(1);
      expect(s7d.total_cost_usd).toBeCloseTo(0.02);

      const s30d = engine.computeSummary('30d');
      expect(s30d.total_sessions).toBe(2);
      expect(s30d.total_messages).toBe(2);
    });
  });

  describe('tokensByProject', () => {
    it('groups message_completed events by project_key', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', project_key: 'proj-a', input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 5000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', project_key: 'proj-a', input_tokens: 8000, output_tokens: 1500, cache_read_input_tokens: 3000, total_cost_usd: 0.02 }),
        makeEvent({ event_type: 'message_completed', project_key: 'proj-b', input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 2000, total_cost_usd: 0.01 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.tokensByProject('7d');
      expect(rows).toHaveLength(2);
      const a = rows.find(r => r.project_key === 'proj-a')!;
      expect(a.input_tokens).toBe(18000);
      expect(a.output_tokens).toBe(3500);
      expect(a.cache_read_input_tokens).toBe(8000);
      expect(a.cost_usd).toBeCloseTo(0.05);
      expect(a.message_count).toBe(2);
    });
  });

  describe('tokensBySession', () => {
    it('groups message_completed events by session_id', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', session_id: 'sess-1', input_tokens: 10000, output_tokens: 2000, total_cost_usd: 0.03, duration_ms: 30000 }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-1', input_tokens: 8000, output_tokens: 1500, total_cost_usd: 0.02, duration_ms: 20000 }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-2', input_tokens: 5000, output_tokens: 1000, total_cost_usd: 0.01, duration_ms: 15000 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.tokensBySession('7d');
      expect(rows).toHaveLength(2);
      const s1 = rows.find(r => r.session_id === 'sess-1')!;
      expect(s1.input_tokens).toBe(18000);
      expect(s1.message_count).toBe(2);
      expect(s1.duration_ms).toBe(50000);
    });
  });

  describe('bucketed methods', () => {
    it('sessionsOverTime returns bucketed session_start counts', () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', timestamp: hourAgo.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: now.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: now.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.bucketed('24h', 'hour', 'session_start');
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBe(3);
    });

    it('messagesOverTime returns bucketed message_completed counts', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 1000, output_tokens: 100, total_cost_usd: 0.01 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 2000, output_tokens: 200, total_cost_usd: 0.02 }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.bucketed('24h', 'hour', 'message_completed');
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBe(2);
    });

    it('costOverTime returns bucketed cost sums', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 1000, output_tokens: 100, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 2000, output_tokens: 200, total_cost_usd: 0.05 }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.bucketed('24h', 'hour', 'message_completed', 'total_cost_usd');
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBeCloseTo(0.08);
    });
  });

  describe('modelBreakdown', () => {
    it('groups by model field', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', model: 'claude-sonnet-4-20250514', input_tokens: 10000, output_tokens: 2000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', model: 'claude-sonnet-4-20250514', input_tokens: 5000, output_tokens: 1000, total_cost_usd: 0.02 }),
        makeEvent({ event_type: 'message_completed', model: 'claude-haiku-4-5-20251001', input_tokens: 3000, output_tokens: 500, total_cost_usd: 0.005 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.modelBreakdown('7d');
      expect(rows).toHaveLength(2);
      const sonnet = rows.find(r => r.model === 'claude-sonnet-4-20250514')!;
      expect(sonnet.input_tokens).toBe(15000);
      expect(sonnet.cost_usd).toBeCloseTo(0.05);
    });
  });

  describe('personaBreakdown', () => {
    it('groups message_routed by agent_target', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_routed', agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_routed', agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_routed', agent_target: 'pm' }),
        makeEvent({ event_type: 'message_routed' }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.personaBreakdown('7d');
      expect(rows).toHaveLength(3);
      const eng = rows.find(r => r.agent === 'engineer')!;
      expect(eng.count).toBe(2);
    });
  });

  describe('cacheEfficiency', () => {
    it('computes cache hit ratio', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 10000, cache_read_input_tokens: 5000, total_cost_usd: 0.03, output_tokens: 0 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 10000, cache_read_input_tokens: 8000, total_cost_usd: 0.02, output_tokens: 0 }),
      ]);
      const engine = createActivityEngine(filePath);
      const ce = engine.cacheEfficiency('7d');
      expect(ce.total_input_tokens).toBe(20000);
      expect(ce.cache_read_tokens).toBe(13000);
      // cache_hit_ratio = cache_read / (cache_read + input) = 13000 / 33000 ≈ 0.394
      expect(ce.cache_hit_ratio).toBeCloseTo(13000 / 33000);
    });

    it('returns 0 ratio when no input tokens', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      const ce = engine.cacheEfficiency('7d');
      expect(ce.cache_hit_ratio).toBe(0);
    });
  });

  describe('sessionDurations', () => {
    it('returns durations from session_end and session_idle events', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_end', session_id: 'sess-1', duration_ms: 60000 }),
        makeEvent({ event_type: 'session_idle', session_id: 'sess-2', duration_ms: 30000 }),
      ]);
      const engine = createActivityEngine(filePath);
      const durations = engine.sessionDurations('7d');
      expect(durations).toHaveLength(2);
      expect(durations[0].duration_ms).toBe(60000);
      expect(durations[1].duration_ms).toBe(30000);
    });
  });

  describe('sessionTimeline', () => {
    it('returns empty array for missing file', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toEqual([]);
    });

    it('reconstructs processing and idle segments from pulse events', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:05:00Z');
      const t3 = new Date('2026-03-29T10:06:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-abc12345xyz', timestamp: t0.toISOString(), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-abc12345xyz', timestamp: t1.toISOString(), agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-abc12345xyz', timestamp: t2.toISOString(), agent_target: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-abc12345xyz', timestamp: t3.toISOString(), duration_ms: 360000 }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].session_id).toBe('sess-abc12345xyz');
      expect(timeline[0].label).toBe('mpg/sess-abc/engineer');
      expect(timeline[0].segments).toHaveLength(3);
      // idle: session_start → message_routed
      expect(timeline[0].segments[0]).toEqual({
        start: t0.toISOString(),
        end: t1.toISOString(),
        state: 'idle',
      });
      // processing: message_routed → message_completed (with token enrichment)
      expect(timeline[0].segments[1]).toEqual({
        start: t1.toISOString(),
        end: t2.toISOString(),
        state: 'processing',
        token_count: 0,
        token_rate: 0,
      });
      // idle: message_completed → session_end
      expect(timeline[0].segments[2]).toEqual({
        start: t2.toISOString(),
        end: t3.toISOString(),
        state: 'idle',
      });
    });

    it('handles multiple processing bursts in a single session', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:02:00Z');
      const t3 = new Date('2026-03-29T10:03:00Z');
      const t4 = new Date('2026-03-29T10:04:00Z');
      const t5 = new Date('2026-03-29T10:05:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-multi000', timestamp: t0.toISOString(), agent_name: 'pm' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-multi000', timestamp: t1.toISOString(), agent_target: 'pm' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-multi000', timestamp: t2.toISOString() }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-multi000', timestamp: t3.toISOString(), agent_target: 'pm' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-multi000', timestamp: t4.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-multi000', timestamp: t5.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].segments).toHaveLength(5);
      expect(timeline[0].segments.map(s => s.state)).toEqual([
        'idle', 'processing', 'idle', 'processing', 'idle',
      ]);
    });

    it('uses agent_name from session_start for label, falls back to agent_target', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-noagent0', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-noagent0', timestamp: t0.toISOString(), agent_target: 'designer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-noagent0', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline[0].label).toBe('mpg/sess-noa/designer');
    });

    it('falls back to "default" when no agent info available', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-bare0000', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-bare0000', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline[0].label).toBe('mpg/sess-bar/default');
    });

    it('handles session_idle as session end', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:05:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-idle0000', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'session_idle', session_id: 'sess-idle0000', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].segments).toHaveLength(1);
      expect(timeline[0].segments[0].state).toBe('idle');
      expect(timeline[0].segments[0].end).toBe(t1.toISOString());
    });

    it('handles multiple sessions', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:02:00Z');
      const t3 = new Date('2026-03-29T10:03:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-aaaa0000', timestamp: t0.toISOString(), agent_name: 'pm' }),
        makeEvent({ event_type: 'session_start', session_id: 'sess-bbbb0000', timestamp: t1.toISOString(), agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-aaaa0000', timestamp: t2.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-bbbb0000', timestamp: t3.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(2);
      const labels = timeline.map(t => t.label);
      expect(labels).toContain('mpg/sess-aaa/pm');
      expect(labels).toContain('mpg/sess-bbb/engineer');
    });

    it('filters by time range', () => {
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const recent = new Date();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-old00000', timestamp: old.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-old00000', timestamp: old.toISOString() }),
        makeEvent({ event_type: 'session_start', session_id: 'sess-new00000', timestamp: recent.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-new00000', timestamp: recent.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      expect(engine.sessionTimeline('7d')).toHaveLength(1);
      expect(engine.sessionTimeline('30d')).toHaveLength(2);
    });

    it('handles session with no end event (uses last event timestamp)', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:05:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-noend000', timestamp: t0.toISOString(), agent_name: 'pm' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-noend000', timestamp: t1.toISOString(), agent_target: 'pm' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-noend000', timestamp: t2.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      // Should still have segments up to last known event
      expect(timeline[0].segments).toHaveLength(2);
      expect(timeline[0].segments[0].state).toBe('idle');
      expect(timeline[0].segments[1].state).toBe('processing');
      expect(timeline[0].segments[1].end).toBe(t2.toISOString());
    });

    it('enriches processing segments with token_count and token_rate', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z'); // routed
      const t2 = new Date('2026-03-29T10:05:00Z'); // completed (4 min = 240s processing)
      const t3 = new Date('2026-03-29T10:06:00Z'); // session end
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-tok00000', timestamp: t0.toISOString(), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-tok00000', timestamp: t1.toISOString(), agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-tok00000', timestamp: t2.toISOString(), input_tokens: 5000, output_tokens: 3000 }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-tok00000', timestamp: t3.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      const processingSegment = timeline[0].segments.find(s => s.state === 'processing');
      expect(processingSegment).toBeDefined();
      // 5000 + 3000 = 8000 tokens over 240 seconds = 33 tok/s (rounded)
      expect(processingSegment!.token_count).toBe(8000);
      expect(processingSegment!.token_rate).toBe(Math.round(8000 / 240));
    });

    it('idle segments have no token fields', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-idl00000', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-idl00000', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      const idleSegment = timeline[0].segments[0];
      expect(idleSegment.state).toBe('idle');
      expect(idleSegment.token_count).toBeUndefined();
      expect(idleSegment.token_rate).toBeUndefined();
    });
  });

  it('skips malformed JSONL lines without crashing', () => {
    writeFileSync(filePath, '{"event_type":"session_start","timestamp":"' + new Date().toISOString() + '","session_id":"s","project_key":"p","project_dir":"d"}\nNOT JSON\n');
    const engine = createActivityEngine(filePath);
    const s = engine.computeSummary('7d');
    expect(s.total_sessions).toBe(1);
  });
});
