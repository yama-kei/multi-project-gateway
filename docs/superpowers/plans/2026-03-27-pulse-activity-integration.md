> **Superseded** by `2026-03-27-activity-dashboard-token-usage.md`. This file describes the implementation plan for the original Approach B (pulse CLI proxy). The agreed design is Approach A (self-contained activity engine). Kept for historical reference only.

# Pulse Activity Integration — Implementation Plan

> **For agentic workers:** Do NOT execute this plan. Use `2026-03-27-activity-dashboard-token-usage.md` instead.

**Goal:** ~~Original pulse CLI proxy plan~~ **Superseded** — see `2026-03-27-activity-dashboard-token-usage.md`

**Architecture:** MPG writes JSONL events (including `message_completed` with `ClaudeUsage` data) to `~/.pulse/events/mpg-sessions.jsonl`. A new `activity-engine.ts` reads JSONL in-process, filters by time range, and computes aggregations. No pulse CLI dependency.

**Tech Stack:** Node.js (fs), Chart.js 4 via CDN, Vitest for tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/claude-cli.ts` | Modify | Add `ClaudeUsage` interface, extend `ClaudeResult`, update `parseClaudeJsonOutput` |
| `tests/claude-cli.test.ts` | Modify | Add usage extraction tests |
| `src/pulse-events.ts` | Modify | Add `messageCompleted` method to `PulseEmitter` |
| `tests/pulse-events.test.ts` | Modify | Add `messageCompleted` event test |
| `src/activity-engine.ts` | Create | JSONL reader + aggregation engine |
| `tests/activity-engine.test.ts` | Create | Activity engine unit tests |
| `src/session-manager.ts` | Modify | Emit `message_completed` after `runClaude()` with usage data |
| `tests/session-manager.test.ts` | Modify | Add `message_completed` emission test |
| `src/health-server.ts` | Modify | Replace pulse CLI proxy with activity engine, update Activity tab |
| `tests/health-server.test.ts` | Modify | Update activity endpoint tests to use mock engine |
| `src/cli.ts` | Modify | Wire up `createActivityEngine()` and pass to health server |

---

### Task 1: Extend `ClaudeResult` and Add `message_completed` Pulse Event

**Files:**
- Modify: `src/claude-cli.ts`, `tests/claude-cli.test.ts`
- Modify: `src/pulse-events.ts`, `tests/pulse-events.test.ts`

- [ ] **Step 1: Write failing tests for ClaudeUsage extraction**

Add to `tests/claude-cli.test.ts`:

```typescript
describe('parseClaudeJsonOutput — usage extraction', () => {
  it('extracts ClaudeUsage when usage fields are present', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.042,
      duration_ms: 45000,
      duration_api_ms: 38000,
      num_turns: 12,
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 15000,
        output_tokens: 3200,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 8000,
      },
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeDefined();
    expect(result.usage!.input_tokens).toBe(15000);
    expect(result.usage!.output_tokens).toBe(3200);
    expect(result.usage!.cache_creation_input_tokens).toBe(5000);
    expect(result.usage!.cache_read_input_tokens).toBe(8000);
    expect(result.usage!.total_cost_usd).toBe(0.042);
    expect(result.usage!.duration_ms).toBe(45000);
    expect(result.usage!.duration_api_ms).toBe(38000);
    expect(result.usage!.num_turns).toBe(12);
    expect(result.usage!.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns undefined usage when no usage fields present', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeUndefined();
  });

  it('handles partial usage fields gracefully', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.01,
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage).toBeDefined();
    expect(result.usage!.total_cost_usd).toBe(0.01);
    expect(result.usage!.input_tokens).toBe(0);
    expect(result.usage!.output_tokens).toBe(0);
  });
});
```

- [ ] **Step 2: Write failing tests for `messageCompleted` pulse event**

Add to `tests/pulse-events.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/claude-cli.test.ts tests/pulse-events.test.ts`
Expected: FAIL — `usage` not on `ClaudeResult`, `messageCompleted` not on `PulseEmitter`

- [ ] **Step 4: Implement `ClaudeUsage` and update `parseClaudeJsonOutput`**

In `src/claude-cli.ts`:

Add the `ClaudeUsage` interface:

```typescript
export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  model?: string;
}
```

Add `usage?: ClaudeUsage` to the `ClaudeResult` interface.

Update `parseClaudeJsonOutput`:

```typescript
export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  let usage: ClaudeUsage | undefined;
  if (data.total_cost_usd != null || data.usage) {
    usage = {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
      total_cost_usd: data.total_cost_usd ?? 0,
      duration_ms: data.duration_ms ?? 0,
      duration_api_ms: data.duration_api_ms ?? 0,
      num_turns: data.num_turns ?? 0,
      model: data.model,
    };
  }
  return {
    text: data.result ?? '',
    sessionId: data.session_id ?? '',
    isError: Boolean(data.is_error),
    usage,
  };
}
```

- [ ] **Step 5: Implement `messageCompleted` on `PulseEmitter`**

In `src/pulse-events.ts`:

Import `ClaudeUsage`:

```typescript
import type { ClaudeUsage } from './claude-cli.js';
```

Add to the `PulseEmitter` interface:

```typescript
messageCompleted(sessionId: string, projectKey: string, projectDir: string, usage: ClaudeUsage, opts?: { agentTarget?: string }): void;
```

Add to the `createPulseEmitter` return object:

```typescript
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/claude-cli.test.ts tests/pulse-events.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/claude-cli.ts tests/claude-cli.test.ts src/pulse-events.ts tests/pulse-events.test.ts
git commit -m "feat(#64): add ClaudeUsage extraction and message_completed pulse event"
```

---

### Task 2: Build Activity Engine (`src/activity-engine.ts`)

**Files:**
- Create: `src/activity-engine.ts`
- Create: `tests/activity-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/activity-engine.test.ts`:

```typescript
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

  describe('summaryCards', () => {
    it('returns zero values for empty file', () => {
      const engine = createActivityEngine(filePath);
      const cards = engine.summaryCards('7d');
      expect(cards.totalCostUsd).toBe(0);
      expect(cards.totalInputTokens).toBe(0);
      expect(cards.totalOutputTokens).toBe(0);
      expect(cards.totalSessions).toBe(0);
      expect(cards.totalMessages).toBe(0);
      expect(cards.avgSessionDurationMs).toBe(0);
    });

    it('returns zero values for missing file', () => {
      const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
      const cards = engine.summaryCards('7d');
      expect(cards.totalCostUsd).toBe(0);
      expect(cards.totalSessions).toBe(0);
    });

    it('aggregates message_completed events', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start' }),
        makeEvent({
          event_type: 'message_completed',
          input_tokens: 10000, output_tokens: 2000,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 5000,
          total_cost_usd: 0.03, duration_ms: 30000, num_turns: 5,
        }),
        makeEvent({
          event_type: 'message_completed',
          input_tokens: 8000, output_tokens: 1500,
          cache_creation_input_tokens: 1000, cache_read_input_tokens: 3000,
          total_cost_usd: 0.02, duration_ms: 20000, num_turns: 3,
        }),
        makeEvent({ event_type: 'session_end', duration_ms: 60000, message_count: 2 }),
      ]);
      const engine = createActivityEngine(filePath);
      const cards = engine.summaryCards('7d');
      expect(cards.totalSessions).toBe(1);
      expect(cards.totalMessages).toBe(2);
      expect(cards.totalCostUsd).toBeCloseTo(0.05);
      expect(cards.totalInputTokens).toBe(18000);
      expect(cards.totalOutputTokens).toBe(3500);
      expect(cards.avgSessionDurationMs).toBe(60000);
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
      const cards7d = engine.summaryCards('7d');
      expect(cards7d.totalSessions).toBe(1);
      expect(cards7d.totalMessages).toBe(1);
      expect(cards7d.totalCostUsd).toBeCloseTo(0.02);

      const cards30d = engine.summaryCards('30d');
      expect(cards30d.totalSessions).toBe(2);
      expect(cards30d.totalMessages).toBe(2);
    });

    it('filters by project when specified', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', project_key: 'project-a' }),
        makeEvent({ event_type: 'message_completed', project_key: 'project-a', input_tokens: 10000, output_tokens: 1000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'session_start', project_key: 'project-b' }),
        makeEvent({ event_type: 'message_completed', project_key: 'project-b', input_tokens: 5000, output_tokens: 500, total_cost_usd: 0.01 }),
      ]);
      const engine = createActivityEngine(filePath);
      const cards = engine.summaryCards('7d', 'project-a');
      expect(cards.totalSessions).toBe(1);
      expect(cards.totalMessages).toBe(1);
      expect(cards.totalCostUsd).toBeCloseTo(0.03);
    });
  });

  describe('tokensByProject', () => {
    it('groups message_completed events by project_key', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', project_key: 'project-a', input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 5000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', project_key: 'project-a', input_tokens: 8000, output_tokens: 1500, cache_read_input_tokens: 3000, total_cost_usd: 0.02 }),
        makeEvent({ event_type: 'message_completed', project_key: 'project-b', input_tokens: 5000, output_tokens: 1000, cache_read_input_tokens: 2000, total_cost_usd: 0.01 }),
      ]);
      const engine = createActivityEngine(filePath);
      const rows = engine.tokensByProject('7d');
      expect(rows).toHaveLength(2);
      const a = rows.find(r => r.projectKey === 'project-a')!;
      expect(a.inputTokens).toBe(18000);
      expect(a.outputTokens).toBe(3500);
      expect(a.cacheReadTokens).toBe(8000);
      expect(a.totalCostUsd).toBeCloseTo(0.05);
      expect(a.messageCount).toBe(2);
      const b = rows.find(r => r.projectKey === 'project-b')!;
      expect(b.inputTokens).toBe(5000);
      expect(b.messageCount).toBe(1);
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
      const s1 = rows.find(r => r.sessionId === 'sess-1')!;
      expect(s1.inputTokens).toBe(18000);
      expect(s1.messageCount).toBe(2);
      expect(s1.durationMs).toBe(50000); // sum of duration_ms
    });
  });

  describe('time-bucketed methods', () => {
    it('sessionsOverTime returns bucketed session_start counts', () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      writeEvents(filePath, [
        makeEvent({ event_type: 'session_start', timestamp: hourAgo.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: now.toISOString() }),
        makeEvent({ event_type: 'session_start', timestamp: now.toISOString() }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.sessionsOverTime('24h', 'hour');
      expect(buckets.length).toBeGreaterThanOrEqual(1);
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBe(3);
    });

    it('messagesOverTime returns bucketed message_completed counts', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 1000, output_tokens: 100, total_cost_usd: 0.01 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 2000, output_tokens: 200, total_cost_usd: 0.02 }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.messagesOverTime('24h', 'hour');
      const total = buckets.reduce((sum, b) => sum + b.value, 0);
      expect(total).toBe(2);
    });

    it('costOverTime returns bucketed total_cost_usd sums', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 1000, output_tokens: 100, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 2000, output_tokens: 200, total_cost_usd: 0.05 }),
      ]);
      const engine = createActivityEngine(filePath);
      const buckets = engine.costOverTime('24h', 'hour');
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
      expect(sonnet.inputTokens).toBe(15000);
      expect(sonnet.messageCount).toBe(2);
    });
  });

  describe('cacheEfficiency', () => {
    it('computes cache hit ratio', () => {
      writeEvents(filePath, [
        makeEvent({ event_type: 'message_completed', input_tokens: 10000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 2000, total_cost_usd: 0.03 }),
        makeEvent({ event_type: 'message_completed', input_tokens: 10000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 1500, total_cost_usd: 0.02 }),
      ]);
      const engine = createActivityEngine(filePath);
      const ce = engine.cacheEfficiency('7d');
      expect(ce.totalInputTokens).toBe(20000);
      expect(ce.cacheReadTokens).toBe(13000);
      expect(ce.cacheCreationTokens).toBe(1500);
      expect(ce.cacheHitRatio).toBeCloseTo(0.65); // 13000 / 20000
    });

    it('returns 0 ratio when no input tokens', () => {
      const engine = createActivityEngine(filePath);
      const ce = engine.cacheEfficiency('7d');
      expect(ce.cacheHitRatio).toBe(0);
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
      expect(durations[0].durationMs).toBe(60000);
      expect(durations[1].durationMs).toBe(30000);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: FAIL — cannot resolve `../src/activity-engine.js`

- [ ] **Step 3: Implement the activity engine**

Create `src/activity-engine.ts`:

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type TimeRange = '24h' | '7d' | '30d';
export type Bucket = 'hour' | 'day';

export interface SummaryCards {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  totalMessages: number;
  avgSessionDurationMs: number;
}

export interface ProjectTokenRow {
  projectKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

export interface SessionTokenRow {
  sessionId: string;
  projectKey: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  messageCount: number;
  durationMs: number;
}

export interface TimeBucketEntry {
  bucket: string;
  value: number;
}

export interface SessionDurationRow {
  sessionId: string;
  projectKey: string;
  durationMs: number;
}

export interface ModelBreakdownRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  messageCount: number;
}

export interface CacheEfficiency {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRatio: number;
}

export interface ActivityEngine {
  summaryCards(range: TimeRange, project?: string): SummaryCards;
  tokensByProject(range: TimeRange): ProjectTokenRow[];
  tokensBySession(range: TimeRange, project?: string): SessionTokenRow[];
  sessionsOverTime(range: TimeRange, bucket: Bucket): TimeBucketEntry[];
  messagesOverTime(range: TimeRange, bucket: Bucket): TimeBucketEntry[];
  costOverTime(range: TimeRange, bucket: Bucket): TimeBucketEntry[];
  sessionDurations(range: TimeRange, project?: string): SessionDurationRow[];
  modelBreakdown(range: TimeRange): ModelBreakdownRow[];
  cacheEfficiency(range: TimeRange, project?: string): CacheEfficiency;
}

const DEFAULT_PATH = join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

const RANGE_MS: Record<TimeRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface RawEvent {
  schema_version?: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

function readEvents(filePath: string): RawEvent[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function filterByRange(events: RawEvent[], range: TimeRange, project?: string): RawEvent[] {
  const cutoff = Date.now() - RANGE_MS[range];
  return events.filter(e => {
    if (new Date(e.timestamp).getTime() < cutoff) return false;
    if (project && e.project_key !== project) return false;
    return true;
  });
}

function bucketKey(timestamp: string, bucket: Bucket): string {
  const d = new Date(timestamp);
  if (bucket === 'hour') {
    d.setMinutes(0, 0, 0);
  } else {
    d.setHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

function groupIntoBuckets(events: RawEvent[], bucket: Bucket, valueFn: (e: RawEvent) => number): TimeBucketEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const key = bucketKey(e.timestamp, bucket);
    map.set(key, (map.get(key) ?? 0) + valueFn(e));
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, value]) => ({ bucket, value }));
}

export function createActivityEngine(filePath?: string): ActivityEngine {
  const target = filePath ?? DEFAULT_PATH;

  function getFiltered(range: TimeRange, project?: string, eventType?: string): RawEvent[] {
    const all = readEvents(target);
    const filtered = filterByRange(all, range, project);
    if (eventType) return filtered.filter(e => e.event_type === eventType);
    return filtered;
  }

  return {
    summaryCards(range, project) {
      const events = filterByRange(readEvents(target), range, project);
      const sessions = events.filter(e => e.event_type === 'session_start');
      const messages = events.filter(e => e.event_type === 'message_completed');
      const endings = events.filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');

      const totalCostUsd = messages.reduce((s, e) => s + (Number(e.total_cost_usd) || 0), 0);
      const totalInputTokens = messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0);
      const totalOutputTokens = messages.reduce((s, e) => s + (Number(e.output_tokens) || 0), 0);
      const totalDuration = endings.reduce((s, e) => s + (Number(e.duration_ms) || 0), 0);

      return {
        totalCostUsd,
        totalInputTokens,
        totalOutputTokens,
        totalSessions: sessions.length,
        totalMessages: messages.length,
        avgSessionDurationMs: endings.length > 0 ? totalDuration / endings.length : 0,
      };
    },

    tokensByProject(range) {
      const messages = getFiltered(range, undefined, 'message_completed');
      const map = new Map<string, ProjectTokenRow>();
      for (const e of messages) {
        const key = e.project_key;
        const row = map.get(key) ?? { projectKey: key, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCostUsd: 0, messageCount: 0 };
        row.inputTokens += Number(e.input_tokens) || 0;
        row.outputTokens += Number(e.output_tokens) || 0;
        row.cacheReadTokens += Number(e.cache_read_input_tokens) || 0;
        row.totalCostUsd += Number(e.total_cost_usd) || 0;
        row.messageCount++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    tokensBySession(range, project) {
      const messages = getFiltered(range, project, 'message_completed');
      const map = new Map<string, SessionTokenRow>();
      for (const e of messages) {
        const key = e.session_id;
        const row = map.get(key) ?? { sessionId: key, projectKey: e.project_key, inputTokens: 0, outputTokens: 0, totalCostUsd: 0, messageCount: 0, durationMs: 0 };
        row.inputTokens += Number(e.input_tokens) || 0;
        row.outputTokens += Number(e.output_tokens) || 0;
        row.totalCostUsd += Number(e.total_cost_usd) || 0;
        row.durationMs += Number(e.duration_ms) || 0;
        row.messageCount++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    sessionsOverTime(range, bucket) {
      const sessions = getFiltered(range, undefined, 'session_start');
      return groupIntoBuckets(sessions, bucket, () => 1);
    },

    messagesOverTime(range, bucket) {
      const messages = getFiltered(range, undefined, 'message_completed');
      return groupIntoBuckets(messages, bucket, () => 1);
    },

    costOverTime(range, bucket) {
      const messages = getFiltered(range, undefined, 'message_completed');
      return groupIntoBuckets(messages, bucket, e => Number(e.total_cost_usd) || 0);
    },

    sessionDurations(range, project) {
      const endings = filterByRange(readEvents(target), range, project)
        .filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');
      return endings.map(e => ({
        sessionId: e.session_id,
        projectKey: e.project_key,
        durationMs: Number(e.duration_ms) || 0,
      }));
    },

    modelBreakdown(range) {
      const messages = getFiltered(range, undefined, 'message_completed');
      const map = new Map<string, ModelBreakdownRow>();
      for (const e of messages) {
        const model = String(e.model ?? 'unknown');
        const row = map.get(model) ?? { model, inputTokens: 0, outputTokens: 0, totalCostUsd: 0, messageCount: 0 };
        row.inputTokens += Number(e.input_tokens) || 0;
        row.outputTokens += Number(e.output_tokens) || 0;
        row.totalCostUsd += Number(e.total_cost_usd) || 0;
        row.messageCount++;
        map.set(model, row);
      }
      return Array.from(map.values());
    },

    cacheEfficiency(range, project) {
      const messages = getFiltered(range, project, 'message_completed');
      const totalInputTokens = messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0);
      const cacheReadTokens = messages.reduce((s, e) => s + (Number(e.cache_read_input_tokens) || 0), 0);
      const cacheCreationTokens = messages.reduce((s, e) => s + (Number(e.cache_creation_input_tokens) || 0), 0);
      return {
        totalInputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cacheHitRatio: totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0,
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/activity-engine.ts tests/activity-engine.test.ts
git commit -m "feat(#64): add self-contained activity engine with JSONL reader and aggregations"
```

---

### Task 3: Hook `message_completed` into Session Manager

**Files:**
- Modify: `src/session-manager.ts`
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/session-manager.test.ts`, inside the existing `describe('pulse event emission', ...)` block:

```typescript
    it('emits message_completed after successful runClaude with usage data', async () => {
      const { runClaude } = await import('../src/claude-cli.js');
      vi.mocked(runClaude).mockReset();
      vi.mocked(runClaude).mockResolvedValue({
        text: 'Mock response',
        sessionId: 'mock-session-id',
        isError: false,
        usage: {
          input_tokens: 15000,
          output_tokens: 3200,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 8000,
          total_cost_usd: 0.042,
          duration_ms: 45000,
          duration_api_ms: 38000,
          num_turns: 12,
          model: 'claude-sonnet-4-20250514',
        },
      });

      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageCompleted).toHaveBeenCalledOnce();
      expect(pulseEmitter.messageCompleted).toHaveBeenCalledWith(
        expect.any(String),
        'project-a',
        '/tmp/a',
        expect.objectContaining({
          input_tokens: 15000,
          output_tokens: 3200,
          total_cost_usd: 0.042,
        }),
        expect.any(Object),
      );
    });

    it('does not emit message_completed when usage is absent', async () => {
      const { runClaude } = await import('../src/claude-cli.js');
      vi.mocked(runClaude).mockReset();
      vi.mocked(runClaude).mockResolvedValue({
        text: 'Mock response',
        sessionId: 'mock-session-id',
        isError: false,
      });

      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageCompleted).not.toHaveBeenCalled();
    });
```

Also add `messageCompleted` to the `pulseEmitter` mock object in the `beforeEach`:

```typescript
      pulseEmitter = {
        sessionStart: vi.fn(),
        sessionEnd: vi.fn(),
        sessionIdle: vi.fn(),
        sessionResume: vi.fn(),
        messageRouted: vi.fn(),
        messageCompleted: vi.fn(),
      };
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: FAIL — `messageCompleted` not called

- [ ] **Step 3: Add `message_completed` emission to session manager**

In `src/session-manager.ts`, in the `processQueue` function, after the successful `runClaude()` call and after `session.messageCount++`, add:

```typescript
        if (pulseEmitter && session.sessionId && result.usage) {
          pulseEmitter.messageCompleted(
            session.sessionId,
            session.projectKey,
            session.cwd,
            result.usage,
            { agentTarget: undefined },
          );
        }
```

Add the same block after the retry success path (after `session.messageCount++` in the retry block).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat(#64): emit message_completed with usage data from session manager"
```

---

### Task 4: Update API Endpoints to Use Activity Engine

**Files:**
- Modify: `src/health-server.ts`
- Modify: `tests/health-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('activity endpoints', ...)` block in `tests/health-server.test.ts`:

```typescript
  describe('activity endpoints', () => {
    function makeMockEngine() {
      return {
        summaryCards: vi.fn().mockReturnValue({
          totalCostUsd: 1.23, totalInputTokens: 500000, totalOutputTokens: 50000,
          totalSessions: 10, totalMessages: 42, avgSessionDurationMs: 120000,
        }),
        tokensByProject: vi.fn().mockReturnValue([
          { projectKey: 'proj-a', inputTokens: 300000, outputTokens: 30000, cacheReadTokens: 100000, totalCostUsd: 0.8, messageCount: 25 },
        ]),
        tokensBySession: vi.fn().mockReturnValue([
          { sessionId: 'sess-1', projectKey: 'proj-a', inputTokens: 150000, outputTokens: 15000, totalCostUsd: 0.4, messageCount: 12, durationMs: 60000 },
        ]),
        sessionsOverTime: vi.fn().mockReturnValue([{ bucket: '2026-03-27T00:00:00.000Z', value: 5 }]),
        messagesOverTime: vi.fn().mockReturnValue([{ bucket: '2026-03-27T00:00:00.000Z', value: 20 }]),
        costOverTime: vi.fn().mockReturnValue([{ bucket: '2026-03-27T00:00:00.000Z', value: 0.5 }]),
        sessionDurations: vi.fn().mockReturnValue([{ sessionId: 'sess-1', projectKey: 'proj-a', durationMs: 60000 }]),
        modelBreakdown: vi.fn().mockReturnValue([{ model: 'claude-sonnet-4-20250514', inputTokens: 500000, outputTokens: 50000, totalCostUsd: 1.23, messageCount: 42 }]),
        cacheEfficiency: vi.fn().mockReturnValue({ totalInputTokens: 500000, cacheReadTokens: 200000, cacheCreationTokens: 50000, cacheHitRatio: 0.4 }),
      };
    }

    it('GET /api/activity/summary returns aggregated data', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.totalCostUsd).toBe(1.23);
      expect(body.summary.totalSessions).toBe(10);
      expect(body.sessionsOverTime).toHaveLength(1);
      expect(body.modelBreakdown).toHaveLength(1);
      expect(body.cacheEfficiency.cacheHitRatio).toBe(0.4);
      expect(engine.summaryCards).toHaveBeenCalledWith('7d', undefined);
    });

    it('GET /api/activity/summary forwards project filter', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      await httpGet(port, '/api/activity/summary?range=24h&project=proj-a');
      expect(engine.summaryCards).toHaveBeenCalledWith('24h', 'proj-a');
      expect(engine.sessionsOverTime).toHaveBeenCalledWith('24h', 'hour');
    });

    it('GET /api/activity/summary returns empty data when no engine provided', async () => {
      const port = getPort();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/summary');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.totalCostUsd).toBe(0);
      expect(body.summary.totalSessions).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health-server.test.ts`
Expected: FAIL — `activityEngine` not recognized in `HealthServerOptions`

- [ ] **Step 3: Replace pulse CLI proxy with activity engine in health-server.ts**

In `src/health-server.ts`:

**Remove** the `execFile` import, `defaultRunPulseCli` function, and `runPulseCli` from `HealthServerOptions`.

**Update** `HealthServerOptions`:

```typescript
import type { ActivityEngine } from './activity-engine.js';

export interface HealthServerOptions {
  activityEngine?: ActivityEngine;
}
```

**Remove** `const runPulse = options?.runPulseCli ?? defaultRunPulseCli;`

**Replace** both activity endpoint handlers with a single `/api/activity/summary` handler that calls the engine directly:

```typescript
    if (pathname === '/api/activity/summary') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const range = (url.searchParams.get('range') || '7d') as import('./activity-engine.js').TimeRange;
      const project = url.searchParams.get('project') || undefined;
      const bucket: import('./activity-engine.js').Bucket = range === '24h' ? 'hour' : 'day';

      const engine = options?.activityEngine;
      if (!engine) {
        const empty = { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalSessions: 0, totalMessages: 0, avgSessionDurationMs: 0 };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          summary: empty, sessionsOverTime: [], messagesOverTime: [], costOverTime: [],
          tokensByProject: [], tokensBySession: [], modelBreakdown: [],
          cacheEfficiency: { totalInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitRatio: 0 },
          sessionDurations: [],
        }));
        return;
      }

      try {
        const data = {
          summary: engine.summaryCards(range, project),
          sessionsOverTime: engine.sessionsOverTime(range, bucket),
          messagesOverTime: engine.messagesOverTime(range, bucket),
          costOverTime: engine.costOverTime(range, bucket),
          tokensByProject: engine.tokensByProject(range),
          tokensBySession: engine.tokensBySession(range, project),
          modelBreakdown: engine.modelBreakdown(range),
          cacheEfficiency: engine.cacheEfficiency(range, project),
          sessionDurations: engine.sessionDurations(range, project),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to compute activity data' }));
      }
      return;
    }
```

**Remove** the old `/api/activity/sessions` handler (or keep as a simplified version if backward compatibility is needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/health-server.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/health-server.ts tests/health-server.test.ts
git commit -m "feat(#64): replace pulse CLI proxy with in-process activity engine"
```

---

### Task 5: Update Dashboard Activity Tab

**Files:**
- Modify: `src/health-server.ts` (the `buildDashboardHtml()` function)

- [ ] **Step 1: Update the Activity tab HTML to match new data structure**

In `src/health-server.ts`, modify the `buildDashboardHtml()` function. Replace the Activity tab content with:

**Summary Cards (top row)**:
```html
<div id="tab-activity" style="display:none">
  <div class="range-selector">
    <button class="range-btn active" data-range="24h">24h</button>
    <button class="range-btn" data-range="7d">7d</button>
    <button class="range-btn" data-range="30d">30d</button>
  </div>

  <div class="summary-cards">
    <div class="summary-card"><div class="summary-value" id="total-cost">$0.00</div><div class="summary-label">Total Cost</div></div>
    <div class="summary-card"><div class="summary-value" id="total-tokens">0</div><div class="summary-label">Total Tokens</div></div>
    <div class="summary-card"><div class="summary-value" id="total-sessions">0</div><div class="summary-label">Sessions</div></div>
    <div class="summary-card"><div class="summary-value" id="total-messages">0</div><div class="summary-label">Messages</div></div>
    <div class="summary-card"><div class="summary-value" id="avg-duration">0m</div><div class="summary-label">Avg Duration</div></div>
  </div>
```

**Charts (2×3 grid)**:
```html
  <div class="chart-grid">
    <div class="chart-card"><h3>Messages Over Time</h3><canvas id="messages-chart"></canvas></div>
    <div class="chart-card"><h3>Cost Over Time</h3><canvas id="cost-chart"></canvas></div>
    <div class="chart-card"><h3>Sessions Over Time</h3><canvas id="sessions-chart"></canvas></div>
    <div class="chart-card"><h3>Token Usage Over Time</h3><canvas id="tokens-chart"></canvas></div>
    <div class="chart-card"><h3>Persona Breakdown</h3><canvas id="persona-chart"></canvas></div>
    <div class="chart-card"><h3>Model Breakdown</h3><canvas id="model-chart"></canvas></div>
  </div>
```

**Tables**:
```html
  <h3>Token Usage by Project</h3>
  <div id="project-table"></div>
  <h3>Token Usage by Session</h3>
  <div id="session-table"></div>
  <h3>Cache Efficiency</h3>
  <div id="cache-table"></div>
</div>
```

**Summary card CSS**:
```css
.summary-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
.summary-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
.summary-value { font-size: 24px; font-weight: bold; color: #e1e4e8; }
.summary-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
```

- [ ] **Step 2: Update the Activity JavaScript to use new API response shape**

Replace the `refreshActivity()` function:

```javascript
function refreshActivity() {
  var bucket = currentRange === '24h' ? 'hour' : 'day';
  fetch('/api/activity/summary?range=' + currentRange)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Summary cards
      var s = d.summary;
      document.getElementById('total-cost').textContent = '$' + s.totalCostUsd.toFixed(2);
      var totalTok = s.totalInputTokens + s.totalOutputTokens;
      document.getElementById('total-tokens').textContent = totalTok > 1e6 ? (totalTok / 1e6).toFixed(1) + 'M' : totalTok > 1e3 ? (totalTok / 1e3).toFixed(1) + 'k' : totalTok;
      document.getElementById('total-sessions').textContent = s.totalSessions;
      document.getElementById('total-messages').textContent = s.totalMessages;
      var avgMin = Math.round(s.avgSessionDurationMs / 60000);
      document.getElementById('avg-duration').textContent = avgMin + 'm';

      // Messages Over Time (bar)
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'bar',
        data: { labels: d.messagesOverTime.map(function(e) { return e.bucket; }), datasets: [{ label: 'Messages', data: d.messagesOverTime.map(function(e) { return e.value; }), backgroundColor: '#58a6ff' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Cost Over Time (line)
      destroyChart('cost');
      chartInstances['cost'] = new Chart(document.getElementById('cost-chart'), {
        type: 'line',
        data: { labels: d.costOverTime.map(function(e) { return e.bucket; }), datasets: [{ label: 'Cost ($)', data: d.costOverTime.map(function(e) { return e.value; }), borderColor: '#3fb950', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', callback: function(v) { return '$' + v; } }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Sessions Over Time (bar)
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'bar',
        data: { labels: d.sessionsOverTime.map(function(e) { return e.bucket; }), datasets: [{ label: 'Sessions', data: d.sessionsOverTime.map(function(e) { return e.value; }), backgroundColor: '#d29922' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Token Usage Over Time (stacked bar — compute from tokensBySession is impractical, so use summary totals per bucket)
      // For now, show input vs output as a simple stacked indicator using messagesOverTime as proxy buckets
      // TODO: Could add a dedicated tokenUsageOverTime endpoint for more granularity
      destroyChart('tokens');
      var tokenLabels = d.messagesOverTime.map(function(e) { return e.bucket; });
      chartInstances['tokens'] = new Chart(document.getElementById('tokens-chart'), {
        type: 'bar',
        data: {
          labels: tokenLabels,
          datasets: [
            { label: 'Input', data: d.messagesOverTime.map(function() { return s.totalInputTokens / Math.max(d.messagesOverTime.length, 1); }), backgroundColor: '#58a6ff' },
            { label: 'Output', data: d.messagesOverTime.map(function() { return s.totalOutputTokens / Math.max(d.messagesOverTime.length, 1); }), backgroundColor: '#bc8cff' },
          ]
        },
        options: { scales: { y: { stacked: true, beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Persona Breakdown (doughnut)
      destroyChart('persona');
      var byAgent = {};
      d.tokensByProject.forEach(function(p) {
        var agent = p.projectKey.split(':').pop() || 'default';
        byAgent[agent] = (byAgent[agent] || 0) + p.messageCount;
      });
      var pLabels = Object.keys(byAgent);
      chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
        type: 'doughnut',
        data: { labels: pLabels, datasets: [{ data: pLabels.map(function(k) { return byAgent[k]; }), backgroundColor: CHART_COLORS.slice(0, pLabels.length) }] },
        options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Model Breakdown (doughnut)
      destroyChart('model');
      chartInstances['model'] = new Chart(document.getElementById('model-chart'), {
        type: 'doughnut',
        data: { labels: d.modelBreakdown.map(function(m) { return m.model; }), datasets: [{ data: d.modelBreakdown.map(function(m) { return m.totalCostUsd; }), backgroundColor: CHART_COLORS.slice(0, d.modelBreakdown.length) }] },
        options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Token Usage by Project table
      var pt = document.getElementById('project-table');
      if (d.tokensByProject.length === 0) {
        pt.innerHTML = '<div class="empty">No project data</div>';
      } else {
        var h = '<table><tr><th>Project</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th><th>Messages</th></tr>';
        d.tokensByProject.forEach(function(p) {
          h += '<tr><td>' + escapeHtml(p.projectKey) + '</td><td>' + p.inputTokens.toLocaleString() + '</td><td>' + p.outputTokens.toLocaleString() + '</td><td>' + p.cacheReadTokens.toLocaleString() + '</td><td>$' + p.totalCostUsd.toFixed(3) + '</td><td>' + p.messageCount + '</td></tr>';
        });
        pt.innerHTML = h + '</table>';
      }

      // Token Usage by Session table
      var st = document.getElementById('session-table');
      if (d.tokensBySession.length === 0) {
        st.innerHTML = '<div class="empty">No session data</div>';
      } else {
        var h2 = '<table><tr><th>Session</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Messages</th><th>Duration</th></tr>';
        d.tokensBySession.forEach(function(s) {
          h2 += '<tr><td>' + escapeHtml(s.sessionId.substring(0, 8)) + '</td><td>' + escapeHtml(s.projectKey) + '</td><td>' + s.inputTokens.toLocaleString() + '</td><td>' + s.outputTokens.toLocaleString() + '</td><td>$' + s.totalCostUsd.toFixed(3) + '</td><td>' + s.messageCount + '</td><td>' + Math.round(s.durationMs / 60000) + 'm</td></tr>';
        });
        st.innerHTML = h2 + '</table>';
      }

      // Cache Efficiency table
      var ct = document.getElementById('cache-table');
      var ce = d.cacheEfficiency;
      ct.innerHTML = '<table><tr><th>Total Input</th><th>Cache Read</th><th>Cache Creation</th><th>Hit Ratio</th></tr><tr><td>' + ce.totalInputTokens.toLocaleString() + '</td><td>' + ce.cacheReadTokens.toLocaleString() + '</td><td>' + ce.cacheCreationTokens.toLocaleString() + '</td><td>' + (ce.cacheHitRatio * 100).toFixed(1) + '%</td></tr></table>';
    })
    .catch(function(err) {
      console.error('Activity fetch error:', err);
    });
}
```

**Remove**: The `pulse-warning` div and all `pulse_available` checks from the JavaScript.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/health-server.ts
git commit -m "feat(#64): update Activity tab with summary cards, token charts, and tables"
```

---

### Task 6: Wire Up in CLI, Final Verification

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Wire `createActivityEngine` into CLI startup**

In `src/cli.ts`, add import:

```typescript
import { createActivityEngine } from './activity-engine.js';
```

In the `start()` function, create the engine and pass to health server:

Change:
```typescript
  const healthServer = await createHealthServer(config.port, sessionManager, bot, config);
```
To:
```typescript
  const activityEngine = createActivityEngine();
  const healthServer = await createHealthServer(config.port, sessionManager, bot, config, { activityEngine });
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Run build**

Run: `npx tsup`
Expected: Build completes with no errors

- [ ] **Step 4: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 5: Commit any fixes if needed, then create PR**

```bash
git push -u origin mpg/1487176730681806959-engineer
```

Then create PR:
```bash
gh pr create --title "feat(#64): activity engine with token/cost tracking and dashboard" --body "$(cat <<'EOF'
## Summary
- Extends `ClaudeResult` with `ClaudeUsage` (tokens, cost, duration, model) extracted from Claude CLI JSON output
- Adds `message_completed` pulse event emitted after each successful `runClaude()` call with usage payload
- Adds self-contained `activity-engine.ts` that reads JSONL directly (no pulse CLI dependency) with aggregation methods: summaryCards, tokensByProject/Session, time-bucketed series, model breakdown, cache efficiency
- Replaces pulse CLI proxy in health-server with in-process activity engine
- Updates dashboard Activity tab: summary cards (cost, tokens, sessions, messages, avg duration), 6 charts (messages/cost/sessions over time, token usage, persona/model breakdown), 3 tables (by-project, by-session, cache efficiency)
- Range selector: 24h / 7d / 30d with automatic bucketing

## Test plan
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsup` — build succeeds
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Manual: start MPG, send a message, verify `message_completed` event with usage data in `~/.pulse/events/mpg-sessions.jsonl`
- [ ] Manual: visit dashboard Activity tab, verify summary cards and charts render with data
- [ ] Manual: verify range selector (24h/7d/30d) re-fetches and updates all components
- [ ] Manual: verify tables show per-project, per-session, and cache efficiency data

Closes #64

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
