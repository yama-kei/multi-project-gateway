import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEvents,
  computeSummary,
  tokensByProject,
  tokensBySession,
  bucketedCounts,
  bucketedSums,
  sessionDurations,
  modelBreakdown,
  personaBreakdown,
  cacheEfficiency,
  type PulseEvent,
} from '../src/activity-engine.js';

function makeEvent(overrides: Record<string, unknown>) {
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    event_type: 'message_completed',
    session_id: 'sess-1',
    project_key: 'proj-a',
    project_dir: '/tmp/proj',
    ...overrides,
  };
}

function writeEvents(filePath: string, events: Record<string, unknown>[]) {
  writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

describe('readEvents', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'activity-test-'));
    filePath = join(dir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads and filters events within time range', () => {
    const now = Date.now();
    const events = [
      makeEvent({ timestamp: new Date(now - 3600_000).toISOString(), event_type: 'session_start' }),
      makeEvent({ timestamp: new Date(now - 90_000_000).toISOString(), event_type: 'session_start' }),
    ];
    writeEvents(filePath, events);

    const result = readEvents(filePath, 86_400_000); // 24h
    expect(result).toHaveLength(1);
  });

  it('returns empty array when file does not exist', () => {
    const result = readEvents('/nonexistent/path.jsonl', 86_400_000);
    expect(result).toEqual([]);
  });

  it('skips malformed lines', () => {
    writeFileSync(filePath, 'not json\n' + JSON.stringify(makeEvent({ event_type: 'session_start' })) + '\n');
    const result = readEvents(filePath, 86_400_000);
    expect(result).toHaveLength(1);
  });
});

describe('computeSummary', () => {
  it('aggregates totals from message_completed and session events', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', input_tokens: 100, output_tokens: 50, total_cost_usd: 0.01 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', input_tokens: 200, output_tokens: 75, total_cost_usd: 0.02 }) as PulseEvent,
      makeEvent({ event_type: 'session_start' }) as PulseEvent,
      makeEvent({ event_type: 'session_start' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed' }) as PulseEvent,
      makeEvent({ event_type: 'session_end', duration_ms: 60000 }) as PulseEvent,
      makeEvent({ event_type: 'session_idle', duration_ms: 30000 }) as PulseEvent,
    ];
    const summary = computeSummary(events);
    expect(summary.total_cost_usd).toBeCloseTo(0.03);
    expect(summary.total_input_tokens).toBe(300);
    expect(summary.total_output_tokens).toBe(125);
    expect(summary.total_sessions).toBe(2);
    expect(summary.total_messages).toBe(3);
    expect(summary.avg_session_duration_ms).toBe(45000);
  });

  it('returns zeros for empty events', () => {
    const summary = computeSummary([]);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.total_sessions).toBe(0);
  });
});

describe('tokensByProject', () => {
  it('groups token usage by project_key', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', project_key: 'proj-a', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500, total_cost_usd: 0.01 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', project_key: 'proj-a', input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 300, total_cost_usd: 0.02 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', project_key: 'proj-b', input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 100, total_cost_usd: 0.005 }) as PulseEvent,
    ];
    const result = tokensByProject(events);
    expect(result).toHaveLength(2);
    const a = result.find(r => r.project_key === 'proj-a')!;
    expect(a.input_tokens).toBe(300);
    expect(a.output_tokens).toBe(125);
    expect(a.cache_read_input_tokens).toBe(800);
    expect(a.cost_usd).toBeCloseTo(0.03);
    expect(a.message_count).toBe(2);
  });
});

describe('tokensBySession', () => {
  it('groups token usage by session_id', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', session_id: 's1', project_key: 'proj-a', input_tokens: 100, output_tokens: 50, total_cost_usd: 0.01, duration_ms: 1000 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', session_id: 's1', project_key: 'proj-a', input_tokens: 200, output_tokens: 75, total_cost_usd: 0.02, duration_ms: 2000 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', session_id: 's2', project_key: 'proj-b', input_tokens: 50, output_tokens: 25, total_cost_usd: 0.005, duration_ms: 500 }) as PulseEvent,
    ];
    const result = tokensBySession(events);
    expect(result).toHaveLength(2);
    const s1 = result.find(r => r.session_id === 's1')!;
    expect(s1.input_tokens).toBe(300);
    expect(s1.message_count).toBe(2);
    expect(s1.duration_ms).toBe(3000);
  });
});

describe('bucketedCounts', () => {
  it('buckets events by hour', () => {
    const base = new Date('2026-03-27T10:30:00Z');
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_routed', timestamp: new Date(base.getTime()).toISOString() }) as PulseEvent,
      makeEvent({ event_type: 'message_routed', timestamp: new Date(base.getTime() + 1000).toISOString() }) as PulseEvent,
      makeEvent({ event_type: 'message_routed', timestamp: new Date(base.getTime() + 3_600_000).toISOString() }) as PulseEvent,
    ];
    const result = bucketedCounts(events, 'message_routed', 'hour');
    expect(result).toHaveLength(2);
    const tenOClock = result.find(r => r.bucket === '10:00');
    expect(tenOClock?.value).toBe(2);
  });

  it('buckets events by day', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'session_start', timestamp: '2026-03-25T10:00:00Z' }) as PulseEvent,
      makeEvent({ event_type: 'session_start', timestamp: '2026-03-25T14:00:00Z' }) as PulseEvent,
      makeEvent({ event_type: 'session_start', timestamp: '2026-03-26T10:00:00Z' }) as PulseEvent,
    ];
    const result = bucketedCounts(events, 'session_start', 'day');
    expect(result).toHaveLength(2);
    const mar25 = result.find(r => r.bucket === '03-25');
    expect(mar25?.value).toBe(2);
  });
});

describe('bucketedSums', () => {
  it('sums a numeric field by time bucket', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', timestamp: '2026-03-27T10:30:00Z', total_cost_usd: 0.01 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', timestamp: '2026-03-27T10:45:00Z', total_cost_usd: 0.02 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', timestamp: '2026-03-27T11:15:00Z', total_cost_usd: 0.03 }) as PulseEvent,
    ];
    const result = bucketedSums(events, 'message_completed', 'total_cost_usd', 'hour');
    const tenOClock = result.find(r => r.bucket === '10:00');
    expect(tenOClock?.value).toBeCloseTo(0.03);
  });
});

describe('sessionDurations', () => {
  it('extracts durations from session_end and session_idle events', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'session_end', session_id: 's1', project_key: 'proj-a', duration_ms: 60000 }) as PulseEvent,
      makeEvent({ event_type: 'session_idle', session_id: 's2', project_key: 'proj-b', duration_ms: 30000 }) as PulseEvent,
      makeEvent({ event_type: 'message_routed' }) as PulseEvent,
    ];
    const result = sessionDurations(events);
    expect(result).toHaveLength(2);
    expect(result[0].duration_ms).toBe(60000);
    expect(result[1].duration_ms).toBe(30000);
  });
});

describe('modelBreakdown', () => {
  it('groups cost and tokens by model', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', model: 'opus', input_tokens: 100, output_tokens: 50, total_cost_usd: 0.05 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', model: 'opus', input_tokens: 200, output_tokens: 75, total_cost_usd: 0.10 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', model: 'sonnet', input_tokens: 50, output_tokens: 25, total_cost_usd: 0.01 }) as PulseEvent,
    ];
    const result = modelBreakdown(events);
    expect(result).toHaveLength(2);
    const opus = result.find(r => r.model === 'opus')!;
    expect(opus.input_tokens).toBe(300);
    expect(opus.cost_usd).toBeCloseTo(0.15);
  });
});

describe('personaBreakdown', () => {
  it('counts messages per agent_target', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_routed', agent_target: 'engineer' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed', agent_target: 'engineer' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed', agent_target: 'pm' }) as PulseEvent,
      makeEvent({ event_type: 'message_routed', agent_target: undefined }) as PulseEvent,
    ];
    const result = personaBreakdown(events);
    expect(result).toHaveLength(3);
    const eng = result.find(r => r.agent === 'engineer')!;
    expect(eng.count).toBe(2);
    const def = result.find(r => r.agent === 'default')!;
    expect(def.count).toBe(1);
  });
});

describe('cacheEfficiency', () => {
  it('computes cache hit ratio', () => {
    const events: PulseEvent[] = [
      makeEvent({ event_type: 'message_completed', input_tokens: 100, cache_read_input_tokens: 500 }) as PulseEvent,
      makeEvent({ event_type: 'message_completed', input_tokens: 200, cache_read_input_tokens: 300 }) as PulseEvent,
    ];
    const result = cacheEfficiency(events);
    expect(result.total_input_tokens).toBe(300);
    expect(result.cache_read_tokens).toBe(800);
    // ratio = 800 / (300 + 800) = 0.727...
    expect(result.cache_hit_ratio).toBeCloseTo(0.727, 2);
  });

  it('returns zero ratio when no tokens', () => {
    const result = cacheEfficiency([]);
    expect(result.cache_hit_ratio).toBe(0);
  });
});
