# Activity Dashboard: Token Usage & Session Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track token/cost usage per Claude CLI call, emit `message_completed` events with usage payloads, build an in-process activity engine that reads JSONL directly, and render a rich dashboard with cost/token charts and tables.

**Architecture:** MPG writes JSONL events (including `message_completed` with `ClaudeUsage` data) to `~/.pulse/events/mpg-sessions.jsonl`. A new `activity-engine.ts` reads JSONL in-process, filters by time range, and computes aggregations. No pulse CLI dependency.

**Spec:** `docs/superpowers/specs/2026-03-27-activity-dashboard-token-usage-design.md`

**Tech Stack:** Node.js (fs), Chart.js 4 via CDN, Vitest for tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/claude-cli.ts` | Modify | Add `ClaudeUsage` interface, extend `ClaudeResult`, update `parseClaudeJsonOutput` |
| `tests/claude-cli.test.ts` | Modify | Add usage extraction tests |
| `src/pulse-events.ts` | Modify | Add `messageCompleted` method to `PulseEmitter` |
| `tests/pulse-events.test.ts` | Modify | Add `messageCompleted` event test |
| `src/activity-engine.ts` | Create | JSONL reader + aggregation functions |
| `tests/activity-engine.test.ts` | Create | Activity engine unit tests |
| `src/session-manager.ts` | Modify | Emit `message_completed` after `runClaude()` with usage data |
| `tests/session-manager.test.ts` | Modify | Add `message_completed` emission test |
| `src/health-server.ts` | Modify | Replace pulse CLI proxy with activity engine; update Activity tab |
| `tests/health-server.test.ts` | Modify | Update activity endpoint tests to use mock engine |
| `src/cli.ts` | Modify | Wire up `createActivityEngine()` and pass to health server |

---

### Task 1: Extend `ClaudeResult` with `ClaudeUsage`, Update `parseClaudeJsonOutput`

**Files:**
- Modify: `src/claude-cli.ts`
- Modify: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing tests for ClaudeUsage extraction**

Add to `tests/claude-cli.test.ts`, after the existing `describe('parseClaudeJsonOutput', ...)` block:

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

  it('handles partial usage — total_cost_usd without nested usage object', () => {
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

  it('extracts model from first key of modelUsage when model field is absent', () => {
    const raw = JSON.stringify({
      result: 'Hello',
      session_id: 'sess-1',
      is_error: false,
      total_cost_usd: 0.05,
      modelUsage: { 'claude-opus-4-6': { input_tokens: 1000 } },
    });
    const result = parseClaudeJsonOutput(raw);
    expect(result.usage!.model).toBe('claude-opus-4-6');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude-cli.test.ts`
Expected: FAIL — `usage` property does not exist on `ClaudeResult`

- [ ] **Step 3: Implement `ClaudeUsage` and update `parseClaudeJsonOutput`**

In `src/claude-cli.ts`, add the `ClaudeUsage` interface after `ClaudeResult`:

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

Add `usage?: ClaudeUsage` to `ClaudeResult`:

Change:
```typescript
export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  sessionReset?: boolean;
  sessionChanged?: boolean;
}
```
To:
```typescript
export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  sessionReset?: boolean;
  sessionChanged?: boolean;
  usage?: ClaudeUsage;
}
```

Update `parseClaudeJsonOutput`:

Change:
```typescript
export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  return {
    text: data.result ?? '',
    sessionId: data.session_id ?? '',
    isError: Boolean(data.is_error),
  };
}
```
To:
```typescript
export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  let usage: ClaudeUsage | undefined;
  if (data.total_cost_usd != null || data.usage) {
    const model = data.model
      ?? (data.modelUsage ? Object.keys(data.modelUsage)[0] : undefined);
    usage = {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
      total_cost_usd: data.total_cost_usd ?? 0,
      duration_ms: data.duration_ms ?? 0,
      duration_api_ms: data.duration_api_ms ?? 0,
      num_turns: data.num_turns ?? 0,
      model,
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claude-cli.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/claude-cli.ts tests/claude-cli.test.ts
git commit -m "feat(#64): add ClaudeUsage interface and extract usage from CLI output"
```

---

### Task 2: Add `messageCompleted` to PulseEmitter

**Files:**
- Modify: `src/pulse-events.ts`
- Modify: `tests/pulse-events.test.ts`

- [ ] **Step 1: Write failing test for `messageCompleted`**

Add to `tests/pulse-events.test.ts`, inside the existing `describe('PulseEmitter', ...)` block, before the closing `});`:

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pulse-events.test.ts`
Expected: FAIL — `messageCompleted` is not a function

- [ ] **Step 3: Add `messageCompleted` to PulseEmitter**

In `src/pulse-events.ts`:

Add import at top:
```typescript
import type { ClaudeUsage } from './claude-cli.js';
```

Add to the `PulseEmitter` interface (after the `messageRouted` line):
```typescript
  messageCompleted(sessionId: string, projectKey: string, projectDir: string, usage: ClaudeUsage, opts?: { agentTarget?: string }): void;
```

Add to the return object of `createPulseEmitter` (after the `messageRouted` method):
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pulse-events.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/pulse-events.ts tests/pulse-events.test.ts
git commit -m "feat(#64): add messageCompleted event to PulseEmitter"
```

---

### Task 3: Build Activity Engine (`src/activity-engine.ts`)

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
      expect(ce.cache_hit_ratio).toBeCloseTo(0.65);
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

  it('skips malformed JSONL lines without crashing', () => {
    writeFileSync(filePath, '{"event_type":"session_start","timestamp":"' + new Date().toISOString() + '","session_id":"s","project_key":"p","project_dir":"d"}\nNOT JSON\n');
    const engine = createActivityEngine(filePath);
    const s = engine.computeSummary('7d');
    expect(s.total_sessions).toBe(1);
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

const DEFAULT_PATH = join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');

const RANGE_MS: Record<TimeRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface PulseEvent {
  schema_version?: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

function readEvents(filePath: string, range: TimeRange): PulseEvent[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    const cutoff = Date.now() - RANGE_MS[range];
    const events: PulseEvent[] = [];
    for (const line of content.split('\n')) {
      try {
        const e = JSON.parse(line) as PulseEvent;
        if (new Date(e.timestamp).getTime() >= cutoff) {
          events.push(e);
        }
      } catch {
        // Skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
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

export interface ActivityEngine {
  computeSummary(range: TimeRange): {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_sessions: number;
    total_messages: number;
    avg_session_duration_ms: number;
  };
  tokensByProject(range: TimeRange): Array<{
    project_key: string;
    project_dir: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: number;
    message_count: number;
  }>;
  tokensBySession(range: TimeRange): Array<{
    session_id: string;
    project_key: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    message_count: number;
    duration_ms: number;
  }>;
  bucketed(range: TimeRange, bucket: Bucket, eventType: string, valueField?: string): Array<{ bucket: string; value: number }>;
  sessionDurations(range: TimeRange): Array<{
    session_id: string;
    project_key: string;
    duration_ms: number;
  }>;
  modelBreakdown(range: TimeRange): Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  personaBreakdown(range: TimeRange): Array<{
    agent: string;
    count: number;
  }>;
  cacheEfficiency(range: TimeRange): {
    total_input_tokens: number;
    cache_read_tokens: number;
    cache_hit_ratio: number;
  };
}

export function createActivityEngine(filePath?: string): ActivityEngine {
  const target = filePath ?? DEFAULT_PATH;

  function getEvents(range: TimeRange, eventType?: string): PulseEvent[] {
    const events = readEvents(target, range);
    return eventType ? events.filter(e => e.event_type === eventType) : events;
  }

  return {
    computeSummary(range) {
      const events = readEvents(target, range);
      const sessions = events.filter(e => e.event_type === 'session_start');
      const messages = events.filter(e => e.event_type === 'message_completed');
      const endings = events.filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');

      const totalDuration = endings.reduce((s, e) => s + (Number(e.duration_ms) || 0), 0);

      return {
        total_cost_usd: messages.reduce((s, e) => s + (Number(e.total_cost_usd) || 0), 0),
        total_input_tokens: messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0),
        total_output_tokens: messages.reduce((s, e) => s + (Number(e.output_tokens) || 0), 0),
        total_sessions: sessions.length,
        total_messages: messages.length,
        avg_session_duration_ms: endings.length > 0 ? totalDuration / endings.length : 0,
      };
    },

    tokensByProject(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { project_key: string; project_dir: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cost_usd: number; message_count: number }>();
      for (const e of messages) {
        const key = e.project_key;
        const row = map.get(key) ?? { project_key: key, project_dir: e.project_dir, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0, message_count: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cache_read_input_tokens += Number(e.cache_read_input_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        row.message_count++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    tokensBySession(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { session_id: string; project_key: string; input_tokens: number; output_tokens: number; cost_usd: number; message_count: number; duration_ms: number }>();
      for (const e of messages) {
        const key = e.session_id;
        const row = map.get(key) ?? { session_id: key, project_key: e.project_key, input_tokens: 0, output_tokens: 0, cost_usd: 0, message_count: 0, duration_ms: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        row.duration_ms += Number(e.duration_ms) || 0;
        row.message_count++;
        map.set(key, row);
      }
      return Array.from(map.values());
    },

    bucketed(range, bucket, eventType, valueField) {
      const events = getEvents(range, eventType);
      const map = new Map<string, number>();
      for (const e of events) {
        const key = bucketKey(e.timestamp, bucket);
        const val = valueField ? (Number(e[valueField]) || 0) : 1;
        map.set(key, (map.get(key) ?? 0) + val);
      }
      return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([bucket, value]) => ({ bucket, value }));
    },

    sessionDurations(range) {
      const endings = getEvents(range).filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle');
      return endings.map(e => ({
        session_id: e.session_id,
        project_key: e.project_key,
        duration_ms: Number(e.duration_ms) || 0,
      }));
    },

    modelBreakdown(range) {
      const messages = getEvents(range, 'message_completed');
      const map = new Map<string, { model: string; input_tokens: number; output_tokens: number; cost_usd: number }>();
      for (const e of messages) {
        const model = String(e.model ?? 'unknown');
        const row = map.get(model) ?? { model, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
        row.input_tokens += Number(e.input_tokens) || 0;
        row.output_tokens += Number(e.output_tokens) || 0;
        row.cost_usd += Number(e.total_cost_usd) || 0;
        map.set(model, row);
      }
      return Array.from(map.values());
    },

    personaBreakdown(range) {
      const routed = getEvents(range, 'message_routed');
      const map = new Map<string, number>();
      for (const e of routed) {
        const agent = String(e.agent_target ?? 'default');
        map.set(agent, (map.get(agent) ?? 0) + 1);
      }
      return Array.from(map.entries()).map(([agent, count]) => ({ agent, count }));
    },

    cacheEfficiency(range) {
      const messages = getEvents(range, 'message_completed');
      const totalInput = messages.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0);
      const cacheRead = messages.reduce((s, e) => s + (Number(e.cache_read_input_tokens) || 0), 0);
      return {
        total_input_tokens: totalInput,
        cache_read_tokens: cacheRead,
        cache_hit_ratio: totalInput > 0 ? cacheRead / totalInput : 0,
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
git commit -m "feat(#64): add self-contained activity engine with JSONL reader"
```

---

### Task 4: Emit `message_completed` from Session Manager

**Files:**
- Modify: `src/session-manager.ts`
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/session-manager.test.ts`, update the pulse emitter mock in the `describe('pulse event emission', ...)` `beforeEach` to include `messageCompleted`:

Change:
```typescript
      pulseEmitter = {
        sessionStart: vi.fn(),
        sessionEnd: vi.fn(),
        sessionIdle: vi.fn(),
        sessionResume: vi.fn(),
        messageRouted: vi.fn(),
      };
```
To:
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

Also update the `pulseEmitter` type annotation to include the new method:
```typescript
    let pulseEmitter: {
      sessionStart: ReturnType<typeof vi.fn>;
      sessionEnd: ReturnType<typeof vi.fn>;
      sessionIdle: ReturnType<typeof vi.fn>;
      sessionResume: ReturnType<typeof vi.fn>;
      messageRouted: ReturnType<typeof vi.fn>;
      messageCompleted: ReturnType<typeof vi.fn>;
    };
```

Add new tests inside the `describe('pulse event emission', ...)` block:

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
        expect.objectContaining({ agentTarget: undefined }),
      );
    });

    it('does not emit message_completed when usage is absent', async () => {
      await pulseManager.send('project-a', '/tmp/a', 'Hello');
      expect(pulseEmitter.messageCompleted).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: FAIL — `messageCompleted` not called (first test), or type error on mock

- [ ] **Step 3: Emit `message_completed` in processQueue**

In `src/session-manager.ts`, in the `processQueue` function, after the primary `runClaude` success path — right after `session.messageCount++;` (line 176) and before `resetIdleTimer(session);`:

```typescript
        if (pulseEmitter && session.sessionId && result.usage) {
          const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
          pulseEmitter.messageCompleted(
            session.sessionId,
            session.projectKey,
            session.cwd,
            result.usage,
            { agentTarget },
          );
        }
```

Add the same block after the retry success path — after `session.messageCount++;` (line 191) and before `resetIdleTimer(session);`:

```typescript
            if (pulseEmitter && session.sessionId && result.usage) {
              const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
              pulseEmitter.messageCompleted(
                session.sessionId,
                session.projectKey,
                session.cwd,
                result.usage,
                { agentTarget },
              );
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat(#64): emit message_completed with usage data from session manager"
```

---

### Task 5: Replace Pulse CLI Proxy with Activity Engine in Health Server

**Files:**
- Modify: `src/health-server.ts`
- Modify: `tests/health-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the `describe('activity endpoints', ...)` block in `tests/health-server.test.ts`:

```typescript
  describe('activity endpoints', () => {
    function makeMockEngine() {
      return {
        computeSummary: vi.fn().mockReturnValue({
          total_cost_usd: 1.23, total_input_tokens: 500000, total_output_tokens: 50000,
          total_sessions: 10, total_messages: 42, avg_session_duration_ms: 120000,
        }),
        tokensByProject: vi.fn().mockReturnValue([
          { project_key: 'proj-a', project_dir: '/tmp/a', input_tokens: 300000, output_tokens: 30000, cache_read_input_tokens: 100000, cost_usd: 0.8, message_count: 25 },
        ]),
        tokensBySession: vi.fn().mockReturnValue([
          { session_id: 'sess-1', project_key: 'proj-a', input_tokens: 150000, output_tokens: 15000, cost_usd: 0.4, message_count: 12, duration_ms: 60000 },
        ]),
        bucketed: vi.fn().mockReturnValue([{ bucket: '2026-03-27T00:00:00.000Z', value: 5 }]),
        sessionDurations: vi.fn().mockReturnValue([{ session_id: 'sess-1', project_key: 'proj-a', duration_ms: 60000 }]),
        modelBreakdown: vi.fn().mockReturnValue([{ model: 'claude-sonnet-4-20250514', input_tokens: 500000, output_tokens: 50000, cost_usd: 1.23 }]),
        personaBreakdown: vi.fn().mockReturnValue([{ agent: 'engineer', count: 25 }]),
        cacheEfficiency: vi.fn().mockReturnValue({ total_input_tokens: 500000, cache_read_tokens: 200000, cache_hit_ratio: 0.4 }),
      };
    }

    it('GET /api/activity/summary returns aggregated activity data', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      const res = await httpGet(port, '/api/activity/summary?range=7d');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.total_cost_usd).toBe(1.23);
      expect(body.summary.total_sessions).toBe(10);
      expect(body.tokens_by_project).toHaveLength(1);
      expect(body.model_breakdown).toHaveLength(1);
      expect(body.cache_efficiency.cache_hit_ratio).toBe(0.4);
      expect(engine.computeSummary).toHaveBeenCalledWith('7d');
    });

    it('GET /api/activity/summary uses correct bucket for range', async () => {
      const port = getPort();
      const engine = makeMockEngine();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), {
        activityEngine: engine,
      });
      await httpGet(port, '/api/activity/summary?range=24h');
      // bucketed should be called with 'hour' for 24h range
      const bucketedCalls = engine.bucketed.mock.calls;
      for (const call of bucketedCalls) {
        expect(call[1]).toBe('hour');
      }
    });

    it('GET /api/activity/summary returns empty data when no engine provided', async () => {
      const port = getPort();
      server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig());
      const res = await httpGet(port, '/api/activity/summary');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary.total_cost_usd).toBe(0);
      expect(body.summary.total_sessions).toBe(0);
      expect(body.tokens_by_project).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health-server.test.ts`
Expected: FAIL — `activityEngine` not in `HealthServerOptions`

- [ ] **Step 3: Replace pulse CLI proxy with activity engine**

In `src/health-server.ts`:

**Remove** the `execFile` import from line 3.

**Replace** `HealthServerOptions` and `defaultRunPulseCli`:

Change:
```typescript
export interface HealthServerOptions {
  runPulseCli?: (args: string[]) => Promise<string>;
}

function defaultRunPulseCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('pulse', ['activity', ...args], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}
```
To:
```typescript
import type { ActivityEngine, TimeRange, Bucket } from './activity-engine.js';

export interface HealthServerOptions {
  activityEngine?: ActivityEngine;
}
```

**Remove** the `const runPulse = options?.runPulseCli ?? defaultRunPulseCli;` line.

**Replace** both `/api/activity/sessions` and `/api/activity/summary` handlers with a single `/api/activity/summary` handler:

```typescript
    if (pathname === '/api/activity/summary') {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const range = (url.searchParams.get('range') || '7d') as TimeRange;
      const bucket: Bucket = range === '24h' ? 'hour' : 'day';
      const engine = options?.activityEngine;

      if (!engine) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          summary: { total_cost_usd: 0, total_input_tokens: 0, total_output_tokens: 0, total_sessions: 0, total_messages: 0, avg_session_duration_ms: 0 },
          tokens_by_project: [], tokens_by_session: [],
          sessions_over_time: [], messages_over_time: [], cost_over_time: [], tokens_over_time: [],
          session_durations: [], model_breakdown: [], persona_breakdown: [],
          cache_efficiency: { total_input_tokens: 0, cache_read_tokens: 0, cache_hit_ratio: 0 },
        }));
        return;
      }

      try {
        const data = {
          summary: engine.computeSummary(range),
          tokens_by_project: engine.tokensByProject(range),
          tokens_by_session: engine.tokensBySession(range),
          sessions_over_time: engine.bucketed(range, bucket, 'session_start'),
          messages_over_time: engine.bucketed(range, bucket, 'message_completed'),
          cost_over_time: engine.bucketed(range, bucket, 'message_completed', 'total_cost_usd'),
          tokens_over_time: engine.bucketed(range, bucket, 'message_completed', 'input_tokens'),
          session_durations: engine.sessionDurations(range),
          model_breakdown: engine.modelBreakdown(range),
          persona_breakdown: engine.personaBreakdown(range),
          cache_efficiency: engine.cacheEfficiency(range),
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

**Remove** the old `/api/activity/sessions` handler entirely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/health-server.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/health-server.ts tests/health-server.test.ts
git commit -m "feat(#64): replace pulse CLI proxy with in-process activity engine"
```

---

### Task 6: Update Dashboard Activity Tab

**Files:**
- Modify: `src/health-server.ts` (the `buildDashboardHtml()` function)

- [ ] **Step 1: Replace Activity tab HTML**

In `src/health-server.ts`, in `buildDashboardHtml()`:

**Add summary card CSS** to the `<style>` block:
```css
.summary-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 24px; }
.summary-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
.summary-value { font-size: 24px; font-weight: bold; color: #e1e4e8; }
.summary-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
```

**Replace** the Activity tab `<div id="tab-activity" ...>` content with:
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
  <div class="chart-grid">
    <div class="chart-card"><h3>Messages Over Time</h3><canvas id="messages-chart"></canvas></div>
    <div class="chart-card"><h3>Cost Over Time</h3><canvas id="cost-chart"></canvas></div>
    <div class="chart-card"><h3>Sessions Over Time</h3><canvas id="sessions-chart"></canvas></div>
    <div class="chart-card"><h3>Token Usage Over Time</h3><canvas id="tokens-chart"></canvas></div>
    <div class="chart-card"><h3>Persona Breakdown</h3><canvas id="persona-chart"></canvas></div>
    <div class="chart-card"><h3>Model Breakdown</h3><canvas id="model-chart"></canvas></div>
  </div>
  <h3 style="margin:16px 0 8px">Token Usage by Project</h3>
  <div id="project-table"></div>
  <h3 style="margin:16px 0 8px">Token Usage by Session</h3>
  <div id="session-table"></div>
  <h3 style="margin:16px 0 8px">Cache Efficiency</h3>
  <div id="cache-table"></div>
</div>
```

- [ ] **Step 2: Replace Activity tab JavaScript**

Replace the `refreshActivity()` function and remove the `pulse-warning` references:

```javascript
function refreshActivity() {
  fetch('/api/activity/summary?range=' + currentRange)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Summary cards
      var s = d.summary;
      document.getElementById('total-cost').textContent = '$' + s.total_cost_usd.toFixed(2);
      var totalTok = s.total_input_tokens + s.total_output_tokens;
      document.getElementById('total-tokens').textContent = totalTok > 1e6 ? (totalTok / 1e6).toFixed(1) + 'M' : totalTok > 1e3 ? (totalTok / 1e3).toFixed(1) + 'k' : String(totalTok);
      document.getElementById('total-sessions').textContent = String(s.total_sessions);
      document.getElementById('total-messages').textContent = String(s.total_messages);
      document.getElementById('avg-duration').textContent = Math.round(s.avg_session_duration_ms / 60000) + 'm';

      // Messages Over Time (bar)
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'bar',
        data: { labels: d.messages_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Messages', data: d.messages_over_time.map(function(e) { return e.value; }), backgroundColor: '#58a6ff' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Cost Over Time (line)
      destroyChart('cost');
      chartInstances['cost'] = new Chart(document.getElementById('cost-chart'), {
        type: 'line',
        data: { labels: d.cost_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Cost ($)', data: d.cost_over_time.map(function(e) { return e.value; }), borderColor: '#3fb950', tension: 0.3 }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Sessions Over Time (bar)
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'bar',
        data: { labels: d.sessions_over_time.map(function(e) { return e.bucket; }), datasets: [{ label: 'Sessions', data: d.sessions_over_time.map(function(e) { return e.value; }), backgroundColor: '#d29922' }] },
        options: { scales: { y: { beginAtZero: true, ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#30363d' } }, x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { display: false } } }
      });

      // Token Usage Over Time (stacked bar)
      destroyChart('tokens');
      chartInstances['tokens'] = new Chart(document.getElementById('tokens-chart'), {
        type: 'bar',
        data: { labels: d.tokens_over_time.map(function(e) { return e.bucket; }), datasets: [
          { label: 'Input', data: d.tokens_over_time.map(function(e) { return e.value; }), backgroundColor: '#58a6ff' },
        ] },
        options: { scales: { y: { stacked: true, beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Persona Breakdown (doughnut)
      destroyChart('persona');
      chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
        type: 'doughnut',
        data: { labels: d.persona_breakdown.map(function(p) { return p.agent; }), datasets: [{ data: d.persona_breakdown.map(function(p) { return p.count; }), backgroundColor: CHART_COLORS.slice(0, d.persona_breakdown.length) }] },
        options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Model Breakdown (doughnut)
      destroyChart('model');
      chartInstances['model'] = new Chart(document.getElementById('model-chart'), {
        type: 'doughnut',
        data: { labels: d.model_breakdown.map(function(m) { return m.model; }), datasets: [{ data: d.model_breakdown.map(function(m) { return m.cost_usd; }), backgroundColor: CHART_COLORS.slice(0, d.model_breakdown.length) }] },
        options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Token Usage by Project table
      var pt = document.getElementById('project-table');
      if (d.tokens_by_project.length === 0) { pt.innerHTML = '<div class="empty">No data</div>'; }
      else {
        var h = '<table><tr><th>Project</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cost</th><th>Messages</th></tr>';
        d.tokens_by_project.forEach(function(p) { h += '<tr><td>' + escapeHtml(p.project_key) + '</td><td>' + p.input_tokens.toLocaleString() + '</td><td>' + p.output_tokens.toLocaleString() + '</td><td>' + p.cache_read_input_tokens.toLocaleString() + '</td><td>$' + p.cost_usd.toFixed(3) + '</td><td>' + p.message_count + '</td></tr>'; });
        pt.innerHTML = h + '</table>';
      }

      // Token Usage by Session table
      var st = document.getElementById('session-table');
      if (d.tokens_by_session.length === 0) { st.innerHTML = '<div class="empty">No data</div>'; }
      else {
        var h2 = '<table><tr><th>Session</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Msgs</th><th>Duration</th></tr>';
        d.tokens_by_session.forEach(function(row) { h2 += '<tr><td>' + escapeHtml(row.session_id.substring(0, 8)) + '</td><td>' + escapeHtml(row.project_key) + '</td><td>' + row.input_tokens.toLocaleString() + '</td><td>' + row.output_tokens.toLocaleString() + '</td><td>$' + row.cost_usd.toFixed(3) + '</td><td>' + row.message_count + '</td><td>' + Math.round(row.duration_ms / 60000) + 'm</td></tr>'; });
        st.innerHTML = h2 + '</table>';
      }

      // Cache Efficiency table
      var ct = document.getElementById('cache-table');
      var ce = d.cache_efficiency;
      ct.innerHTML = '<table><tr><th>Total Input</th><th>Cache Read</th><th>Hit Ratio</th></tr><tr><td>' + ce.total_input_tokens.toLocaleString() + '</td><td>' + ce.cache_read_tokens.toLocaleString() + '</td><td>' + (ce.cache_hit_ratio * 100).toFixed(1) + '%</td></tr></table>';
    })
    .catch(function(err) { console.error('Activity fetch error:', err); });
}
```

**Remove**: The `pulse-warning` div and all `pulse_available` / `d.pulse_available` checks.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/health-server.ts
git commit -m "feat(#64): update Activity tab with summary cards, token charts, and tables"
```

---

### Task 7: Wire Up in CLI, Final Verification

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Wire `createActivityEngine` into CLI startup**

In `src/cli.ts`, add import:
```typescript
import { createActivityEngine } from './activity-engine.js';
```

Update the health server creation (around line 200).

Change:
```typescript
          healthServer = await createHealthServer(config.defaults.httpPort, sessionManager, bot, config);
```
To:
```typescript
          const activityEngine = createActivityEngine();
          healthServer = await createHealthServer(config.defaults.httpPort, sessionManager, bot, config, { activityEngine });
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
- Adds self-contained `activity-engine.ts` that reads JSONL directly — no pulse CLI dependency
- Replaces pulse CLI proxy in health-server with in-process activity engine
- Updates dashboard Activity tab: 5 summary cards, 6 charts, 3 tables, range selector (24h/7d/30d)

## Test plan
- [ ] `npx vitest run` — all tests pass
- [ ] `npx tsup` — build succeeds
- [ ] `npx tsc --noEmit` — no type errors
- [ ] Manual: start MPG, send a message, verify `message_completed` event in `~/.pulse/events/mpg-sessions.jsonl`
- [ ] Manual: visit dashboard Activity tab, verify summary cards and charts render
- [ ] Manual: verify range selector re-fetches all components
- [ ] Manual: verify per-project, per-session, and cache efficiency tables populate

Closes #64

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
