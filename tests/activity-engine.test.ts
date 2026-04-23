import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    it('groups by project_key when no dirToNameMap provided', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', project_key: 'proj-a', project_dir: '/tmp/a', input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 5000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', project_key: 'proj-a', project_dir: '/tmp/a', input_tokens: 8000, output_tokens: 1500, cache_read_input_tokens: 3000, total_cost_usd: 0.02 }),
        makeEvent({ event_type: 'message_completed', project_key: 'proj-b', project_dir: '/tmp/b', input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 2000, total_cost_usd: 0.01 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.tokensByProject('7d');
      expect(rows).toHaveLength(2);
      const a = rows.find(r => r.project_name === 'proj-a')!;
      expect(a.input_tokens).toBe(18000);
      expect(a.output_tokens).toBe(3500);
      expect(a.cache_read_input_tokens).toBe(8000);
      expect(a.cost_usd).toBeCloseTo(0.05);
      expect(a.message_count).toBe(2);
    });

    it('aggregates by resolved project name from dirToNameMap', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', project_key: 'chan-1:engineer', project_dir: '/home/user/my-project', input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 0, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', project_key: 'chan-1:pm', project_dir: '/home/user/my-project', input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 0, total_cost_usd: 0.01 }),
        makeEvent({ event_type: 'message_completed', project_key: 'chan-2:engineer', project_dir: '/home/user/other-project', input_tokens: 3000, output_tokens: 500, cache_read_input_tokens: 0, total_cost_usd: 0.005 }),
      ]);
      const engine = createActivityEngine(filePath);
      const dirMap = { '/home/user/my-project': 'cool-project', '/home/user/other-project': 'other-project' };
      const rows = engine.tokensByProject('7d', dirMap);
      expect(rows).toHaveLength(2);
      const cool = rows.find(r => r.project_name === 'cool-project')!;
      expect(cool.input_tokens).toBe(15000);
      expect(cool.output_tokens).toBe(3000);
      expect(cool.cost_usd).toBeCloseTo(0.04);
      expect(cool.message_count).toBe(2);
    });

    it('resolves worktree subdirectories via dirToNameMap', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', project_key: 'chan-1:engineer', project_dir: '/home/user/project/.worktrees/chan-1-engineer', input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 0, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', project_key: 'chan-1:pm', project_dir: '/home/user/project', input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 0, total_cost_usd: 0.01 }),
      ]);
      const engine = createActivityEngine(filePath);
      const dirMap = { '/home/user/project': 'my-project' };
      const rows = engine.tokensByProject('7d', dirMap);
      expect(rows).toHaveLength(1);
      expect(rows[0].project_name).toBe('my-project');
      expect(rows[0].input_tokens).toBe(15000);
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

    it('15min bucket groups events into 15-minute intervals', () => {
      const base = new Date();
      base.setMinutes(2, 0, 0);  // :02
      const t1 = new Date(base);
      const t2 = new Date(base.getTime() + 5 * 60 * 1000);  // :07 — same 15min bucket as t1 (0-14)
      const t3 = new Date(base.getTime() + 20 * 60 * 1000); // :22 — next 15min bucket (15-29)
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', timestamp: t1.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: t2.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: t3.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.bucketed('3h', '15min', 'session_start');
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBe(3);
      // All 15min slots in 3h range are present (including zero-filled ones)
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      const nonZero = buckets.filter(b => b.value > 0);
      expect(nonZero.length).toBe(2);
      expect(nonZero[0].value).toBe(2);
      expect(nonZero[1].value).toBe(1);
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

  describe('turnComplexity', () => {
    it('buckets message_completed events into low/medium/high', () => {
      writeEvents(filePath, [
        // low: num_turns <= 3 AND duration_ms < 30000
        makeEvent({ event_type: 'message_completed', num_turns: 2, duration_ms: 5000 }),
        makeEvent({ event_type: 'message_completed', num_turns: 3, duration_ms: 29000 }),
        // medium: in-between
        makeEvent({ event_type: 'message_completed', num_turns: 5, duration_ms: 60000 }),
        // high: num_turns >= 10 OR duration_ms >= 120000
        makeEvent({ event_type: 'message_completed', num_turns: 12, duration_ms: 50000 }),
        makeEvent({ event_type: 'message_completed', num_turns: 4, duration_ms: 150000 }),
      ]);
      const engine = createActivityEngine(filePath);
      const c = engine.turnComplexity('7d');
      expect(c.low).toBe(2);
      expect(c.medium).toBe(1);
      expect(c.high).toBe(2);
    });

    it('treats missing num_turns/duration_ms as zero (bucketed low)', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed' }),
      ]);
      const engine = createActivityEngine(filePath);
      const c = engine.turnComplexity('7d');
      expect(c).toEqual({ low: 1, medium: 0, high: 0 });
    });

    it('returns zero counts for missing file', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      expect(engine.turnComplexity('7d')).toEqual({ low: 0, medium: 0, high: 0 });
    });

    it('ignores non-message_completed events', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start' }),
        makeEvent({ event_type: 'message_routed' }),
      ]);
      const engine = createActivityEngine(filePath);
      expect(engine.turnComplexity('7d')).toEqual({ low: 0, medium: 0, high: 0 });
    });
  });

  describe('sessionRetries', () => {
    it('counts zero retries when each routed has a successful completion', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-ok', timestamp: t(0), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-ok', timestamp: t(1000), agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-ok', timestamp: t(2000), output_tokens: 100 }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-ok', timestamp: t(3000), agent_target: 'engineer' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-ok', timestamp: t(4000), output_tokens: 50 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        session_id: 'sess-ok',
        agent: 'engineer',
        user_turns: 2,
        retries: 0,
      });
    });

    it('counts consecutive user turns without an intervening success as retries', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-retry', timestamp: t(0), agent_name: 'pm' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-retry', timestamp: t(1000) }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-retry', timestamp: t(2000) }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-retry', timestamp: t(3000) }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-retry', timestamp: t(4000), output_tokens: 100 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows[0]).toMatchObject({ user_turns: 3, retries: 2 });
    });

    it('treats message_completed with zero output_tokens as unsuccessful', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-empty', timestamp: t(0), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-empty', timestamp: t(1000) }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-empty', timestamp: t(2000), output_tokens: 0 }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-empty', timestamp: t(3000) }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-empty', timestamp: t(4000), output_tokens: 50 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows[0]).toMatchObject({ user_turns: 2, retries: 1 });
    });

    it('falls back to agent_target from message_routed when session_start has no agent_name', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-noname', timestamp: t(0) }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-noname', timestamp: t(1000), agent_target: 'designer' }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-noname', timestamp: t(2000), output_tokens: 10 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows[0].agent).toBe('designer');
    });

    it('falls back to "default" when no agent info is available', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-bare', timestamp: t(0) }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-bare', timestamp: t(1000) }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows[0].agent).toBe('default');
    });

    it('returns empty array for missing file', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      expect(engine.sessionRetries('7d')).toEqual([]);
    });

    it('groups by session_id across multiple sessions', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-a', timestamp: t(0), agent_name: 'pm' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-a', timestamp: t(1000) }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-a', timestamp: t(2000) }),
        makeEvent({ event_type: 'session_start', session_id: 'sess-b', timestamp: t(0), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-b', timestamp: t(3000) }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-b', timestamp: t(4000), output_tokens: 100 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.sessionRetries('7d');
      expect(rows).toHaveLength(2);
      const a = rows.find(r => r.session_id === 'sess-a')!;
      const b = rows.find(r => r.session_id === 'sess-b')!;
      expect(a).toMatchObject({ agent: 'pm', user_turns: 2, retries: 1 });
      expect(b).toMatchObject({ agent: 'engineer', user_turns: 1, retries: 0 });
    });

    it('skips sessions with no user turns', () => {
      const base = new Date();
      const t = (offset: number) => new Date(base.getTime() + offset).toISOString();
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-silent', timestamp: t(0), agent_name: 'pm' }),
      ]);
      const engine = createActivityEngine(filePath);
      expect(engine.sessionRetries('7d')).toEqual([]);
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
    // Tests use hardcoded 2026-03-29 timestamps; freeze system time so readEvents'
    // range filter (Date.now() - rangeMs) doesn't drop them as time passes.
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-29T16:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

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
      expect(timeline[0].label).toBe('unknown/roject-a/engineer');
      expect(timeline[0].thread_id).toBe('project-a');
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
      expect(timeline[0].label).toBe('unknown/roject-a/designer');
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
      expect(timeline[0].label).toBe('unknown/roject-a/default');
    });

    it('resolves project name from projectNameMap', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-proj0000', timestamp: t0.toISOString(), project_key: '123456789', agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-proj0000', timestamp: t1.toISOString(), project_key: '123456789' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d', { '123456789': 'my-cool-project' });
      expect(timeline[0].label).toBe('my-cool-project/23456789/engineer');
    });

    it('resolves project name from dirToNameMap via project_dir', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-dir00000', timestamp: t0.toISOString(), project_key: '999', project_dir: '/home/user/my-project', agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-dir00000', timestamp: t1.toISOString(), project_key: '999', project_dir: '/home/user/my-project' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d', {}, { '/home/user/my-project': 'cool-project' });
      expect(timeline[0].label).toBe('cool-project/999/engineer');
    });

    it('resolves project name from dirToNameMap for worktree subdirectories', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-wt000000', timestamp: t0.toISOString(), project_key: '999:engineer', project_dir: '/home/user/project/.worktrees/999-engineer', agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-wt000000', timestamp: t1.toISOString(), project_key: '999:engineer', project_dir: '/home/user/project/.worktrees/999-engineer' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d', {}, { '/home/user/project': 'my-project' });
      expect(timeline[0].label).toBe('my-project/999/engineer');
    });

    it('prefers dirToNameMap over channelId lookup', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-pref0000', timestamp: t0.toISOString(), project_key: '123456789', project_dir: '/home/user/project', agent_name: 'pm' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-pref0000', timestamp: t1.toISOString(), project_key: '123456789', project_dir: '/home/user/project' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d', { '123456789': 'channel-name' }, { '/home/user/project': 'dir-name' });
      expect(timeline[0].label).toBe('dir-name/23456789/pm');
    });

    it('resolves project name when project_key contains agent suffix', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-agt00000', timestamp: t0.toISOString(), project_key: '123456789:engineer', agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-agt00000', timestamp: t1.toISOString(), project_key: '123456789:engineer' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d', { '123456789': 'my-cool-project' });
      expect(timeline[0].label).toBe('my-cool-project/23456789/engineer');
    });

    it('sessions from the same thread share the same short ID', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:02:00Z');
      const t3 = new Date('2026-03-29T10:03:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-pm000000', timestamp: t0.toISOString(), project_key: '1488241910345895966:pm', agent_name: 'pm' }),
        makeEvent({ event_type: 'session_start', session_id: 'sess-eng00000', timestamp: t1.toISOString(), project_key: '1488241910345895966:engineer', agent_name: 'engineer' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-pm000000', timestamp: t2.toISOString(), project_key: '1488241910345895966:pm' }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-eng00000', timestamp: t3.toISOString(), project_key: '1488241910345895966:engineer' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(2);
      // Both sessions share the same thread short ID (last 8 of channel ID)
      const pmEntry = timeline.find(t => t.label.includes('/pm'))!;
      const engEntry = timeline.find(t => t.label.includes('/engineer'))!;
      expect(pmEntry.label).toBe('unknown/45895966/pm');
      expect(engEntry.label).toBe('unknown/45895966/engineer');
      // Both share the same thread_id
      expect(pmEntry.thread_id).toBe('1488241910345895966');
      expect(engEntry.thread_id).toBe('1488241910345895966');
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
      expect(labels).toContain('unknown/roject-a/pm');
      expect(labels).toContain('unknown/roject-a/engineer');
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

    it('session_resume skips the idle gap so resumed sessions do not appear as long-running', () => {
      // Session starts at 10:00, goes idle at 10:05, resumes 4 hours later at 14:00
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z'); // routed
      const t2 = new Date('2026-03-29T10:05:00Z'); // completed
      const t3 = new Date('2026-03-29T10:06:00Z'); // idle
      const t4 = new Date('2026-03-29T14:00:00Z'); // resume (4h gap)
      const t5 = new Date('2026-03-29T14:01:00Z'); // routed again
      const t6 = new Date('2026-03-29T14:10:00Z'); // completed
      const t7 = new Date('2026-03-29T14:11:00Z'); // session end
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-resume00', timestamp: t0.toISOString(), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-resume00', timestamp: t1.toISOString() }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-resume00', timestamp: t2.toISOString() }),
        makeEvent({ event_type: 'session_idle', session_id: 'sess-resume00', timestamp: t3.toISOString() }),
        makeEvent({ event_type: 'session_resume', session_id: 'sess-resume00', timestamp: t4.toISOString() }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-resume00', timestamp: t5.toISOString() }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-resume00', timestamp: t6.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-resume00', timestamp: t7.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      // Should have segments for both activity windows but NO segment spanning the 4h gap
      // Before resume: idle(t0→t1), processing(t1→t2), idle(t2→t3)
      // After resume:  idle(t4→t5), processing(t5→t6), idle(t6→t7)
      expect(timeline[0].segments).toHaveLength(6);
      expect(timeline[0].segments.map(s => s.state)).toEqual([
        'idle', 'processing', 'idle', 'idle', 'processing', 'idle',
      ]);
      // Verify no segment spans the gap: t3→t4 should not exist
      for (const seg of timeline[0].segments) {
        const startMs = new Date(seg.start).getTime();
        const endMs = new Date(seg.end).getTime();
        // No segment should be longer than 10 minutes (the actual activity windows)
        expect(endMs - startMs).toBeLessThanOrEqual(10 * 60 * 1000);
      }
    });

    it('session_resume during processing (crash recovery) preserves pre-crash segment', () => {
      // Session starts processing, crashes (no session_idle), resumes 2 hours later
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z'); // routed
      const t2 = new Date('2026-03-29T12:00:00Z'); // resume (crash, no idle/completed)
      const t3 = new Date('2026-03-29T12:01:00Z'); // routed again
      const t4 = new Date('2026-03-29T12:05:00Z'); // completed
      const t5 = new Date('2026-03-29T12:06:00Z'); // session end
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-crash000', timestamp: t0.toISOString(), agent_name: 'engineer' }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-crash000', timestamp: t1.toISOString() }),
        // crash happens here — no session_idle or message_completed
        makeEvent({ event_type: 'session_resume', session_id: 'sess-crash000', timestamp: t2.toISOString() }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-crash000', timestamp: t3.toISOString() }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-crash000', timestamp: t4.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-crash000', timestamp: t5.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      const segs = timeline[0].segments;
      // Pre-crash: idle(t0→t1) — processing started at t1 but no end event, so zero-width (dropped)
      // Post-resume: idle(t2→t3), processing(t3→t4), idle(t4→t5)
      expect(segs.map(s => s.state)).toEqual([
        'idle', 'idle', 'processing', 'idle',
      ]);
      // No segment should span the 2h gap
      for (const seg of segs) {
        const dur = new Date(seg.end).getTime() - new Date(seg.start).getTime();
        expect(dur).toBeLessThanOrEqual(10 * 60 * 1000);
      }
    });

    it('synthesizes pending segment for active session with no processing', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-pend0000', timestamp: t0.toISOString(), agent_name: 'engineer' }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].segments).toHaveLength(1);
      expect(timeline[0].segments[0].state).toBe('pending');
      expect(timeline[0].segments[0].start).toBe(t0.toISOString());
      // end should be close to now
      const endMs = new Date(timeline[0].segments[0].end).getTime();
      expect(endMs).toBeGreaterThan(Date.now() - 5000);
      expect(endMs).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('synthesizes pending segment for active session with only idle segments', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-pend1111', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'session_resume', session_id: 'sess-pend1111', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].segments).toHaveLength(1);
      expect(timeline[0].segments[0].state).toBe('pending');
    });

    it('does not synthesize pending for ended sessions with no processing', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-ended000', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'session_end', session_id: 'sess-ended000', timestamp: t1.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      // Should keep the original idle segment, not synthesize pending
      expect(timeline[0].segments.every(s => s.state === 'idle')).toBe(true);
    });

    it('does not synthesize pending for sessions with processing segments', () => {
      const t0 = new Date('2026-03-29T10:00:00Z');
      const t1 = new Date('2026-03-29T10:01:00Z');
      const t2 = new Date('2026-03-29T10:05:00Z');
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', session_id: 'sess-proc0000', timestamp: t0.toISOString() }),
        makeEvent({ event_type: 'message_routed', session_id: 'sess-proc0000', timestamp: t1.toISOString() }),
        makeEvent({ event_type: 'message_completed', session_id: 'sess-proc0000', timestamp: t2.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const timeline = engine.sessionTimeline('7d');
      expect(timeline).toHaveLength(1);
      // Should have idle + processing + closing segment, no pending
      expect(timeline[0].segments.some(s => s.state === 'processing')).toBe(true);
      expect(timeline[0].segments.some(s => s.state === 'pending')).toBe(false);
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
