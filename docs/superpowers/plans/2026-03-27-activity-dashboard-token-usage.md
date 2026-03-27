# Activity Dashboard: Token Usage & Session Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add comprehensive token usage, cost, and session duration metrics to the Activity dashboard, reading directly from the JSONL event file instead of shelling out to the external `pulse` CLI.

**Architecture:** Extend `ClaudeResult` to capture token/cost data from Claude CLI's existing JSON output. Add a `message_completed` pulse event carrying usage data. Build a self-contained JSONL reader + aggregation engine. Rebuild the Activity tab with summary cards, charts, and tables.

**Tech Stack:** TypeScript, Node.js fs (line-by-line JSONL parsing), Chart.js (existing CDN), Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/claude-cli.ts` | Modify | Add `ClaudeUsage` type; extend `ClaudeResult`; update parser |
| `src/pulse-events.ts` | Modify | Add `messageCompleted` method to `PulseEmitter` |
| `src/session-manager.ts` | Modify | Emit `messageCompleted` after successful `runClaude` calls |
| `src/activity-engine.ts` | Create | JSONL reader + all aggregation functions |
| `src/health-server.ts` | Modify | Replace pulse CLI with activity engine; rebuild Activity tab UI |
| `tests/claude-cli.test.ts` | Modify | Add usage extraction tests |
| `tests/pulse-events.test.ts` | Modify | Add `messageCompleted` test |
| `tests/activity-engine.test.ts` | Create | Full test suite for reader + aggregations |
| `tests/health-server.test.ts` | Modify | Update activity endpoint tests for new response shape |

---

### Task 1: Extend `ClaudeResult` with Usage Data

**Files:**
- Modify: `src/claude-cli.ts:1-18`
- Test: `tests/claude-cli.test.ts`

- [ ] **Step 1: Write failing tests for usage extraction**

Add to `tests/claude-cli.test.ts` inside the existing `describe('parseClaudeJsonOutput')` block:

```typescript
it('extracts usage data when present in CLI output', () => {
  const json = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    session_id: 'sess-1',
    total_cost_usd: 0.0553,
    duration_ms: 2282,
    duration_api_ms: 2270,
    num_turns: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 7912,
      cache_read_input_tokens: 11587,
    },
    modelUsage: {
      'claude-opus-4-6[1m]': {
        inputTokens: 100,
        outputTokens: 50,
        costUSD: 0.0553,
      },
    },
  });
  const parsed = parseClaudeJsonOutput(json);
  expect(parsed.usage).toBeDefined();
  expect(parsed.usage!.input_tokens).toBe(100);
  expect(parsed.usage!.output_tokens).toBe(50);
  expect(parsed.usage!.cache_creation_input_tokens).toBe(7912);
  expect(parsed.usage!.cache_read_input_tokens).toBe(11587);
  expect(parsed.usage!.total_cost_usd).toBe(0.0553);
  expect(parsed.usage!.duration_ms).toBe(2282);
  expect(parsed.usage!.duration_api_ms).toBe(2270);
  expect(parsed.usage!.num_turns).toBe(1);
  expect(parsed.usage!.model).toBe('claude-opus-4-6[1m]');
});

it('returns undefined usage when CLI output has no usage fields', () => {
  const json = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello',
    session_id: 'sess-1',
  });
  const parsed = parseClaudeJsonOutput(json);
  expect(parsed.usage).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claude-cli.test.ts`
Expected: 2 failures — `parsed.usage` is undefined in the first test, and the second test may pass vacuously.

- [ ] **Step 3: Implement `ClaudeUsage` and update parser**

In `src/claude-cli.ts`, add the `ClaudeUsage` interface and update `ClaudeResult` and `parseClaudeJsonOutput`:

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

export interface ClaudeResult {
  text: string;
  sessionId: string;
  isError: boolean;
  sessionReset?: boolean;
  sessionChanged?: boolean;
  usage?: ClaudeUsage;
}

export function parseClaudeJsonOutput(raw: string): ClaudeResult {
  const data = JSON.parse(raw);
  let usage: ClaudeUsage | undefined;
  if (data.usage && typeof data.usage.input_tokens === 'number') {
    usage = {
      input_tokens: data.usage.input_tokens ?? 0,
      output_tokens: data.usage.output_tokens ?? 0,
      cache_creation_input_tokens: data.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: data.usage.cache_read_input_tokens ?? 0,
      total_cost_usd: data.total_cost_usd ?? 0,
      duration_ms: data.duration_ms ?? 0,
      duration_api_ms: data.duration_api_ms ?? 0,
      num_turns: data.num_turns ?? 0,
      model: data.modelUsage ? Object.keys(data.modelUsage)[0] : undefined,
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
Expected: All tests pass, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/claude-cli.ts tests/claude-cli.test.ts
git commit -m "feat: extract token usage from Claude CLI JSON output"
```

---

### Task 2: Add `messageCompleted` Pulse Event

**Files:**
- Modify: `src/pulse-events.ts`
- Test: `tests/pulse-events.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/pulse-events.test.ts`:

```typescript
it('emits message_completed event with usage data', () => {
  const emitter = createPulseEmitter(filePath);
  emitter.messageCompleted('sess-1', 'project-a', '/tmp/project', {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 5000,
    cache_read_input_tokens: 12000,
    total_cost_usd: 0.045,
    duration_ms: 3200,
    duration_api_ms: 3100,
    num_turns: 1,
    model: 'claude-opus-4-6[1m]',
  }, { agentTarget: 'engineer' });

  const event = JSON.parse(readFileSync(filePath, 'utf-8').trim());
  expect(event.event_type).toBe('message_completed');
  expect(event.session_id).toBe('sess-1');
  expect(event.project_key).toBe('project-a');
  expect(event.input_tokens).toBe(100);
  expect(event.output_tokens).toBe(50);
  expect(event.cache_creation_input_tokens).toBe(5000);
  expect(event.cache_read_input_tokens).toBe(12000);
  expect(event.total_cost_usd).toBe(0.045);
  expect(event.duration_ms).toBe(3200);
  expect(event.duration_api_ms).toBe(3100);
  expect(event.num_turns).toBe(1);
  expect(event.model).toBe('claude-opus-4-6[1m]');
  expect(event.agent_target).toBe('engineer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pulse-events.test.ts`
Expected: FAIL — `emitter.messageCompleted is not a function`

- [ ] **Step 3: Implement `messageCompleted`**

In `src/pulse-events.ts`, add to the `PulseEmitter` interface:

```typescript
import type { ClaudeUsage } from './claude-cli.js';
```

Add to the interface:

```typescript
messageCompleted(sessionId: string, projectKey: string, projectDir: string, usage: ClaudeUsage, opts?: { agentTarget?: string }): void;
```

Add to the returned object in `createPulseEmitter`:

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
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pulse-events.ts tests/pulse-events.test.ts
git commit -m "feat: add message_completed pulse event with token usage"
```

---

### Task 3: Emit `messageCompleted` from Session Manager

**Files:**
- Modify: `src/session-manager.ts:160-203`

- [ ] **Step 1: Add emission after successful `runClaude` calls**

In `src/session-manager.ts`, in the `processQueue` function, after the line `item.resolve(result);` (line ~182) and also after the retry path `item.resolve({ ...result, sessionReset: true });` (line ~194), add the pulse emission.

After the primary success path (around line 178, after `persistSessions();` and before `if (sessionChanged)`):

```typescript
if (pulseEmitter && result.usage) {
  const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
  pulseEmitter.messageCompleted(
    session.sessionId ?? session.projectKey,
    session.projectKey,
    session.cwd,
    result.usage,
    { agentTarget },
  );
}
```

After the retry success path (around line 193, after `persistSessions();` and before `item.resolve({ ...result, sessionReset: true });`):

```typescript
if (pulseEmitter && result.usage) {
  const agentTarget = session.projectKey.includes(':') ? session.projectKey.split(':').pop() : undefined;
  pulseEmitter.messageCompleted(
    session.sessionId ?? session.projectKey,
    session.projectKey,
    session.cwd,
    result.usage,
    { agentTarget },
  );
}
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/session-manager.ts
git commit -m "feat: emit messageCompleted pulse event after Claude CLI calls"
```

---

### Task 4: Build the Activity Engine

**Files:**
- Create: `src/activity-engine.ts`
- Create: `tests/activity-engine.test.ts`

- [ ] **Step 1: Write failing tests for `readEvents`**

Create `tests/activity-engine.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `readEvents`**

Create `src/activity-engine.ts`:

```typescript
import { readFileSync } from 'node:fs';

export interface PulseEvent {
  schema_version: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

export function readEvents(filePath: string, rangeMs: number): PulseEvent[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const cutoff = Date.now() - rangeMs;
  const events: PulseEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as PulseEvent;
      if (new Date(event.timestamp).getTime() >= cutoff) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}
```

- [ ] **Step 4: Run tests to verify `readEvents` tests pass**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: All `readEvents` tests pass.

- [ ] **Step 5: Write failing tests for aggregation functions**

Add to `tests/activity-engine.test.ts`:

```typescript
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
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: FAIL — functions not exported from module.

- [ ] **Step 7: Implement all aggregation functions**

Add to `src/activity-engine.ts`:

```typescript
export interface SummaryResult {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_sessions: number;
  total_messages: number;
  avg_session_duration_ms: number;
}

export function computeSummary(events: PulseEvent[]): SummaryResult {
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalSessions = 0;
  let totalMessages = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const e of events) {
    switch (e.event_type) {
      case 'message_completed':
        totalCost += (e.total_cost_usd as number) || 0;
        totalInput += (e.input_tokens as number) || 0;
        totalOutput += (e.output_tokens as number) || 0;
        break;
      case 'session_start':
        totalSessions++;
        break;
      case 'message_routed':
        totalMessages++;
        break;
      case 'session_end':
      case 'session_idle':
        totalDuration += (e.duration_ms as number) || 0;
        durationCount++;
        break;
    }
  }

  return {
    total_cost_usd: totalCost,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_sessions: totalSessions,
    total_messages: totalMessages,
    avg_session_duration_ms: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
  };
}

export interface ProjectTokens {
  project_key: string;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  message_count: number;
}

export function tokensByProject(events: PulseEvent[]): ProjectTokens[] {
  const map = new Map<string, ProjectTokens>();
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    const key = e.project_key;
    let entry = map.get(key);
    if (!entry) {
      entry = { project_key: key, project_dir: e.project_dir, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0, message_count: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cache_read_input_tokens += (e.cache_read_input_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
    entry.message_count++;
  }
  return [...map.values()];
}

export interface SessionTokens {
  session_id: string;
  project_key: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  message_count: number;
  duration_ms: number;
}

export function tokensBySession(events: PulseEvent[]): SessionTokens[] {
  const map = new Map<string, SessionTokens>();
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    const key = e.session_id;
    let entry = map.get(key);
    if (!entry) {
      entry = { session_id: key, project_key: e.project_key, input_tokens: 0, output_tokens: 0, cost_usd: 0, message_count: 0, duration_ms: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
    entry.duration_ms += (e.duration_ms as number) || 0;
    entry.message_count++;
  }
  return [...map.values()];
}

export interface BucketEntry {
  bucket: string;
  value: number;
}

function toBucketKey(timestamp: string, bucket: 'hour' | 'day'): string {
  const d = new Date(timestamp);
  if (bucket === 'hour') {
    return d.getUTCHours().toString().padStart(2, '0') + ':00';
  }
  return (d.getUTCMonth() + 1).toString().padStart(2, '0') + '-' + d.getUTCDate().toString().padStart(2, '0');
}

export function bucketedCounts(events: PulseEvent[], eventType: string, bucket: 'hour' | 'day'): BucketEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== eventType) continue;
    const key = toBucketKey(e.timestamp, bucket);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([bucket, value]) => ({ bucket, value })).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function bucketedSums(events: PulseEvent[], eventType: string, field: string, bucket: 'hour' | 'day'): BucketEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== eventType) continue;
    const key = toBucketKey(e.timestamp, bucket);
    map.set(key, (map.get(key) ?? 0) + ((e[field] as number) || 0));
  }
  return [...map.entries()].map(([bucket, value]) => ({ bucket, value })).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface SessionDuration {
  session_id: string;
  project_key: string;
  duration_ms: number;
}

export function sessionDurations(events: PulseEvent[]): SessionDuration[] {
  return events
    .filter(e => e.event_type === 'session_end' || e.event_type === 'session_idle')
    .map(e => ({
      session_id: e.session_id,
      project_key: e.project_key,
      duration_ms: (e.duration_ms as number) || 0,
    }));
}

export interface ModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function modelBreakdown(events: PulseEvent[]): ModelEntry[] {
  const map = new Map<string, ModelEntry>();
  for (const e of events) {
    if (e.event_type !== 'message_completed' || !e.model) continue;
    const key = e.model as string;
    let entry = map.get(key);
    if (!entry) {
      entry = { model: key, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
      map.set(key, entry);
    }
    entry.input_tokens += (e.input_tokens as number) || 0;
    entry.output_tokens += (e.output_tokens as number) || 0;
    entry.cost_usd += (e.total_cost_usd as number) || 0;
  }
  return [...map.values()];
}

export interface PersonaEntry {
  agent: string;
  count: number;
}

export function personaBreakdown(events: PulseEvent[]): PersonaEntry[] {
  const map = new Map<string, number>();
  for (const e of events) {
    if (e.event_type !== 'message_routed') continue;
    const agent = (e.agent_target as string) || 'default';
    map.set(agent, (map.get(agent) ?? 0) + 1);
  }
  return [...map.entries()].map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count);
}

export interface CacheEfficiencyResult {
  total_input_tokens: number;
  cache_read_tokens: number;
  cache_hit_ratio: number;
}

export function cacheEfficiency(events: PulseEvent[]): CacheEfficiencyResult {
  let totalInput = 0;
  let cacheRead = 0;
  for (const e of events) {
    if (e.event_type !== 'message_completed') continue;
    totalInput += (e.input_tokens as number) || 0;
    cacheRead += (e.cache_read_input_tokens as number) || 0;
  }
  const total = totalInput + cacheRead;
  return {
    total_input_tokens: totalInput,
    cache_read_tokens: cacheRead,
    cache_hit_ratio: total > 0 ? cacheRead / total : 0,
  };
}
```

- [ ] **Step 8: Run tests to verify all pass**

Run: `npx vitest run tests/activity-engine.test.ts`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/activity-engine.ts tests/activity-engine.test.ts
git commit -m "feat: add activity engine with JSONL reader and aggregation functions"
```

---

### Task 5: Update Health Server API to Use Activity Engine

**Files:**
- Modify: `src/health-server.ts:1-7,21-33,338-467`
- Test: `tests/health-server.test.ts`

- [ ] **Step 1: Update health server tests for new response shape**

In `tests/health-server.test.ts`, replace the `activity endpoints` describe block with:

```typescript
describe('activity endpoints', () => {
  it('GET /api/activity/summary returns aggregated data from JSONL', async () => {
    const port = getPort();
    const dir = mkdtempSync(join(tmpdir(), 'hs-activity-'));
    const eventsPath = join(dir, 'events.jsonl');
    const now = new Date();
    const events = [
      JSON.stringify({ schema_version: 1, timestamp: now.toISOString(), event_type: 'session_start', session_id: 's1', project_key: 'proj-a', project_dir: '/tmp' }),
      JSON.stringify({ schema_version: 1, timestamp: now.toISOString(), event_type: 'message_routed', session_id: 's1', project_key: 'proj-a', project_dir: '/tmp' }),
      JSON.stringify({ schema_version: 1, timestamp: now.toISOString(), event_type: 'message_completed', session_id: 's1', project_key: 'proj-a', project_dir: '/tmp', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500, total_cost_usd: 0.01, duration_ms: 1000, duration_api_ms: 900, num_turns: 1, model: 'opus' }),
    ];
    writeFileSync(eventsPath, events.join('\n') + '\n');

    server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), { pulseEventsPath: eventsPath });
    const res = await httpGet(port, '/api/activity/summary?range=24h');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary.total_cost_usd).toBeCloseTo(0.01);
    expect(body.summary.total_input_tokens).toBe(100);
    expect(body.summary.total_sessions).toBe(1);
    expect(body.summary.total_messages).toBe(1);
    expect(body.tokens_by_project).toHaveLength(1);
    expect(body.tokens_by_session).toHaveLength(1);
    expect(body.model_breakdown).toHaveLength(1);
    expect(body.cache_efficiency.cache_read_tokens).toBe(500);

    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/activity/summary returns empty data when no events file', async () => {
    const port = getPort();
    server = await createHealthServer(port, makeSessionManager(), makeBot(), makeConfig(), { pulseEventsPath: '/nonexistent.jsonl' });
    const res = await httpGet(port, '/api/activity/summary?range=7d');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary.total_sessions).toBe(0);
    expect(body.tokens_by_project).toEqual([]);
  });
});
```

Add these imports at the top of the test file:

```typescript
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/health-server.test.ts`
Expected: FAIL — `pulseEventsPath` not recognized in options, old response shape expected.

- [ ] **Step 3: Update health server implementation**

In `src/health-server.ts`:

1. Replace imports and options interface:

```typescript
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionManager } from './session-manager.js';
import type { DiscordBot } from './discord.js';
import type { GatewayConfig } from './config.js';
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
} from './activity-engine.js';
```

2. Replace options interface:

```typescript
export interface HealthServerOptions {
  pulseEventsPath?: string;
}
```

3. Remove `defaultRunPulseCli` function entirely.

4. In `createHealthServer`, replace `const runPulse = options?.runPulseCli ?? defaultRunPulseCli;` with:

```typescript
const eventsPath = options?.pulseEventsPath ?? join(homedir(), '.pulse', 'events', 'mpg-sessions.jsonl');
```

5. Replace the `/api/activity/sessions` and `/api/activity/summary` handlers with a single new `/api/activity/summary` handler:

```typescript
if (pathname === '/api/activity/summary') {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const range = url.searchParams.get('range') ?? '7d';
  const rangeMs = range === '24h' ? 86_400_000 : range === '30d' ? 2_592_000_000 : 604_800_000;
  const bucket = (range === '24h' ? 'hour' : 'day') as 'hour' | 'day';

  const events = readEvents(eventsPath, rangeMs);
  const body = JSON.stringify({
    summary: computeSummary(events),
    tokens_by_project: tokensByProject(events),
    tokens_by_session: tokensBySession(events),
    sessions_over_time: bucketedCounts(events, 'session_start', bucket),
    messages_over_time: bucketedCounts(events, 'message_routed', bucket),
    cost_over_time: bucketedSums(events, 'message_completed', 'total_cost_usd', bucket),
    input_tokens_over_time: bucketedSums(events, 'message_completed', 'input_tokens', bucket),
    output_tokens_over_time: bucketedSums(events, 'message_completed', 'output_tokens', bucket),
    session_durations: sessionDurations(events),
    model_breakdown: modelBreakdown(events),
    persona_breakdown: personaBreakdown(events),
    cache_efficiency: cacheEfficiency(events),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
  return;
}
```

6. Remove the old `/api/activity/sessions` handler entirely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/health-server.test.ts`
Expected: All tests pass. (Note: old pulse-specific tests like "forwards query params as CLI flags" should be removed as part of the test update in Step 1.)

- [ ] **Step 5: Commit**

```bash
git add src/health-server.ts tests/health-server.test.ts
git commit -m "feat: replace pulse CLI with built-in activity engine in health server"
```

---

### Task 6: Rebuild Activity Tab Dashboard UI

**Files:**
- Modify: `src/health-server.ts` (the `buildDashboardHtml` function)

- [ ] **Step 1: Replace the Activity tab HTML and JavaScript**

In `src/health-server.ts`, replace the `<div id="tab-activity">` section (lines 114-141) with:

```html
<div id="tab-activity" style="display:none">
  <div class="range-selector">
    <button class="range-btn active" data-range="24h">24h</button>
    <button class="range-btn" data-range="7d">7d</button>
    <button class="range-btn" data-range="30d">30d</button>
  </div>
  <div class="grid" id="activity-cards"></div>
  <div class="chart-grid">
    <div class="chart-card">
      <h3>Messages Over Time</h3>
      <canvas id="messages-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Cost Over Time</h3>
      <canvas id="cost-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Sessions Over Time</h3>
      <canvas id="sessions-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Token Usage Over Time</h3>
      <canvas id="tokens-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Persona Breakdown</h3>
      <canvas id="persona-chart"></canvas>
    </div>
    <div class="chart-card">
      <h3>Model Breakdown</h3>
      <canvas id="model-chart"></canvas>
    </div>
  </div>
  <h3>Token Usage by Project</h3>
  <div id="project-tokens-table"></div>
  <h3>Token Usage by Session</h3>
  <div id="session-tokens-table"></div>
  <h3>Cache Efficiency</h3>
  <div id="cache-table"></div>
</div>
```

- [ ] **Step 2: Replace the Activity tab JavaScript**

Replace the `refreshActivity` function and the chart-related JS (from `var chartInstances = {};` through the end of the `setInterval` for activity refresh) with:

```javascript
var chartInstances = {};
var currentRange = '7d';
var CHART_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#79c0ff'];

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(t) {
    if (t.textContent.toLowerCase() === tab) t.classList.add('active');
  });
  document.getElementById('tab-overview').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('tab-activity').style.display = tab === 'activity' ? '' : 'none';
  if (tab === 'activity') refreshActivity();
}

document.querySelectorAll('.range-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.range-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    refreshActivity();
  });
});

function destroyChart(key) {
  if (chartInstances[key]) { chartInstances[key].destroy(); chartInstances[key] = null; }
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function fmtDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  var h = Math.floor(ms / 3600000);
  var m = Math.round((ms % 3600000) / 60000);
  return h + 'h ' + m + 'm';
}

function fmtCost(n) {
  return '$' + n.toFixed(2);
}

function chartOpts(hideLegend) {
  return {
    scales: {
      y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
      x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }
    },
    plugins: { legend: { display: !hideLegend, labels: { color: '#8b949e' } } }
  };
}

function refreshActivity() {
  fetch('/api/activity/summary?range=' + currentRange)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Summary cards
      var s = d.summary;
      document.getElementById('activity-cards').innerHTML =
        '<div class="card"><div class="card-label">Total Cost</div><div class="card-value">' + fmtCost(s.total_cost_usd) + '</div></div>' +
        '<div class="card"><div class="card-label">Total Tokens</div><div class="card-value">' + fmtTokens(s.total_input_tokens + s.total_output_tokens) + '</div></div>' +
        '<div class="card"><div class="card-label">Sessions</div><div class="card-value">' + s.total_sessions + '</div></div>' +
        '<div class="card"><div class="card-label">Messages</div><div class="card-value">' + s.total_messages + '</div></div>' +
        '<div class="card"><div class="card-label">Avg Duration</div><div class="card-value">' + fmtDuration(s.avg_session_duration_ms) + '</div></div>';

      // Messages Over Time
      var mLabels = d.messages_over_time.map(function(e) { return e.bucket; });
      var mData = d.messages_over_time.map(function(e) { return e.value; });
      destroyChart('messages');
      chartInstances['messages'] = new Chart(document.getElementById('messages-chart'), {
        type: 'bar',
        data: { labels: mLabels, datasets: [{ label: 'Messages', data: mData, backgroundColor: '#58a6ff' }] },
        options: chartOpts(true)
      });

      // Cost Over Time
      var cLabels = d.cost_over_time.map(function(e) { return e.bucket; });
      var cData = d.cost_over_time.map(function(e) { return e.value; });
      destroyChart('cost');
      chartInstances['cost'] = new Chart(document.getElementById('cost-chart'), {
        type: 'line',
        data: { labels: cLabels, datasets: [{ label: 'Cost ($)', data: cData, borderColor: '#3fb950', tension: 0.3 }] },
        options: chartOpts(true)
      });

      // Sessions Over Time
      var sLabels = d.sessions_over_time.map(function(e) { return e.bucket; });
      var sData = d.sessions_over_time.map(function(e) { return e.value; });
      destroyChart('sessions');
      chartInstances['sessions'] = new Chart(document.getElementById('sessions-chart'), {
        type: 'bar',
        data: { labels: sLabels, datasets: [{ label: 'Sessions', data: sData, backgroundColor: '#d29922' }] },
        options: chartOpts(true)
      });

      // Token Usage Over Time (stacked bar: input vs output)
      var allBuckets = {};
      d.input_tokens_over_time.forEach(function(e) { allBuckets[e.bucket] = true; });
      d.output_tokens_over_time.forEach(function(e) { allBuckets[e.bucket] = true; });
      var tLabels = Object.keys(allBuckets).sort();
      var inputMap = {}; d.input_tokens_over_time.forEach(function(e) { inputMap[e.bucket] = e.value; });
      var outputMap = {}; d.output_tokens_over_time.forEach(function(e) { outputMap[e.bucket] = e.value; });
      var tInputData = tLabels.map(function(b) { return inputMap[b] || 0; });
      var tOutputData = tLabels.map(function(b) { return outputMap[b] || 0; });
      destroyChart('tokens');
      chartInstances['tokens'] = new Chart(document.getElementById('tokens-chart'), {
        type: 'bar',
        data: { labels: tLabels, datasets: [
          { label: 'Input', data: tInputData, backgroundColor: '#bc8cff' },
          { label: 'Output', data: tOutputData, backgroundColor: '#79c0ff' }
        ] },
        options: { scales: { y: { beginAtZero: true, stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, x: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } }, plugins: { legend: { labels: { color: '#8b949e' } } } }
      });

      // Persona Breakdown
      var pLabels = d.persona_breakdown.map(function(p) { return p.agent; });
      var pData = d.persona_breakdown.map(function(p) { return p.count; });
      destroyChart('persona');
      if (pLabels.length > 0) {
        chartInstances['persona'] = new Chart(document.getElementById('persona-chart'), {
          type: 'doughnut',
          data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: CHART_COLORS.slice(0, pLabels.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Model Breakdown
      var mdLabels = d.model_breakdown.map(function(m) { return m.model; });
      var mdData = d.model_breakdown.map(function(m) { return m.cost_usd; });
      destroyChart('model');
      if (mdLabels.length > 0) {
        chartInstances['model'] = new Chart(document.getElementById('model-chart'), {
          type: 'doughnut',
          data: { labels: mdLabels, datasets: [{ data: mdData, backgroundColor: CHART_COLORS.slice(0, mdLabels.length) }] },
          options: { plugins: { legend: { labels: { color: '#8b949e' } } } }
        });
      }

      // Token Usage by Project table
      var pt = document.getElementById('project-tokens-table');
      if (d.tokens_by_project.length === 0) {
        pt.innerHTML = '<div class="empty">No token data yet — data appears after new messages are processed</div>';
      } else {
        var ph = '<table><tr><th>Project</th><th>Input Tokens</th><th>Output Tokens</th><th>Cache Read</th><th>Cost</th><th>Messages</th></tr>';
        d.tokens_by_project.forEach(function(p) {
          ph += '<tr><td>' + escapeHtml(p.project_key) + '</td><td>' + fmtTokens(p.input_tokens) + '</td><td>' + fmtTokens(p.output_tokens) + '</td><td>' + fmtTokens(p.cache_read_input_tokens) + '</td><td>' + fmtCost(p.cost_usd) + '</td><td>' + p.message_count + '</td></tr>';
        });
        ph += '</table>';
        pt.innerHTML = ph;
      }

      // Token Usage by Session table
      var st = document.getElementById('session-tokens-table');
      if (d.tokens_by_session.length === 0) {
        st.innerHTML = '<div class="empty">No token data yet</div>';
      } else {
        var sh = '<table><tr><th>Session</th><th>Project</th><th>Input</th><th>Output</th><th>Cost</th><th>Messages</th><th>Duration</th></tr>';
        d.tokens_by_session.forEach(function(s) {
          sh += '<tr><td>' + escapeHtml(s.session_id.slice(0, 12)) + '...</td><td>' + escapeHtml(s.project_key) + '</td><td>' + fmtTokens(s.input_tokens) + '</td><td>' + fmtTokens(s.output_tokens) + '</td><td>' + fmtCost(s.cost_usd) + '</td><td>' + s.message_count + '</td><td>' + fmtDuration(s.duration_ms) + '</td></tr>';
        });
        sh += '</table>';
        st.innerHTML = sh;
      }

      // Cache Efficiency table
      var ct = document.getElementById('cache-table');
      var ce = d.cache_efficiency;
      if (ce.total_input_tokens === 0 && ce.cache_read_tokens === 0) {
        ct.innerHTML = '<div class="empty">No cache data yet</div>';
      } else {
        ct.innerHTML = '<table><tr><th>Total Input Tokens</th><th>Cache Read Tokens</th><th>Hit Ratio</th></tr><tr><td>' + fmtTokens(ce.total_input_tokens) + '</td><td>' + fmtTokens(ce.cache_read_tokens) + '</td><td>' + (ce.cache_hit_ratio * 100).toFixed(1) + '%</td></tr></table>';
      }
    })
    .catch(function(err) {
      console.error('Activity refresh failed:', err);
    });
}

setInterval(function() {
  if (document.getElementById('tab-activity').style.display !== 'none') {
    refreshActivity();
  }
}, 30000);
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass. The dashboard HTML test (`GET /` serves HTML dashboard) should still pass since the HTML structure is still valid.

- [ ] **Step 4: Commit**

```bash
git add src/health-server.ts
git commit -m "feat: rebuild Activity tab with token usage cards, charts, and tables"
```

---

### Task 7: Create GitHub Issue

- [ ] **Step 1: Create the issue**

```bash
gh issue create \
  --title "Activity dashboard: token usage, cost, and session metrics" \
  --body "## Summary

Add comprehensive token/cost/duration metrics to the Activity dashboard tab.

### Changes
- Extract token usage data from Claude CLI JSON output (already present, currently discarded)
- Add \`message_completed\` pulse event carrying usage payload
- Build self-contained JSONL activity engine (replaces external \`pulse\` CLI dependency)
- Rebuild Activity tab with:
  - Summary cards: total cost, tokens, sessions, messages, avg duration
  - Charts: messages/sessions/cost/tokens over time, persona & model breakdowns
  - Tables: token usage by project, by session, cache efficiency
- Time ranges: 24h (hourly buckets), 7d/30d (daily buckets)

### Note on historical data
Session counts, message volume, and durations are available from existing pulse events. Token/cost data starts from new sessions only — the CLI output was previously discarded.

Spec: docs/superpowers/specs/2026-03-27-activity-dashboard-token-usage-design.md
Plan: docs/superpowers/plans/2026-03-27-activity-dashboard-token-usage.md"
```

- [ ] **Step 2: Note the issue number and update commit messages if needed**

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Build the project**

Run: `npx tsup`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit any remaining changes**

```bash
git status
# If any uncommitted changes remain, stage and commit
```
