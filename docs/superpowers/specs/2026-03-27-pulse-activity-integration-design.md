> **Superseded** by `2026-03-27-activity-dashboard-token-usage-design.md` (commit 7a0a5c2). This file describes the original Approach B (pulse CLI proxy). The agreed design is Approach A (self-contained activity engine). Kept for historical reference only.

# Pulse Activity Integration — Design Spec

**Issue**: #64 — Add session activity monitor and graphs to web dashboard
**Date**: 2026-03-27
**Approach**: ~~Thin Proxy — shells out to pulse CLI~~ **Superseded** — see `2026-03-27-activity-dashboard-token-usage-design.md`

---

## Architecture Overview

```
Discord → Session Manager → pulse-events.ts → ~/.pulse/events/mpg-sessions.jsonl
                ↓                                         ↑
         runClaude() → parseClaudeJsonOutput()    activity-engine.ts (reads JSONL directly)
                ↓                                         ↑
         message_completed event (with usage)    /api/activity/* endpoints
                                                          ↑
                                                  Dashboard Activity tab
```

MPG is a **producer** (writes events including token/cost data) and a **reader** (reads and aggregates JSONL in-process). No external CLI dependency — pulse owns the file format, but MPG handles its own reads and aggregations.

---

## 1. ClaudeUsage Interface

**New interface** in `src/claude-cli.ts`:

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

### Extraction from Claude CLI Output

Claude CLI's `--output-format json` response includes token/cost data at the top level. Extend `parseClaudeJsonOutput` to extract these fields into an optional `usage?: ClaudeUsage` on `ClaudeResult`:

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

The parser extracts from Claude CLI JSON:
- `total_cost_usd` → direct mapping
- `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` → from nested `usage` object
- `duration_ms`, `duration_api_ms`, `num_turns` → direct mapping
- `model` → from `model` field if present

If any usage fields are missing, `usage` is `undefined` (graceful degradation for older Claude CLI versions).

---

## 2. New `message_completed` Pulse Event

**Modified file**: `src/pulse-events.ts`

### Extended Interface

Add a new method to `PulseEmitter`:

```typescript
export interface PulseEmitter {
  // ... existing methods unchanged ...
  messageCompleted(
    sessionId: string,
    projectKey: string,
    projectDir: string,
    usage: ClaudeUsage,
    opts?: { agentTarget?: string },
  ): void;
}
```

### Event Schema

```json
{
  "schema_version": 1,
  "timestamp": "2026-03-27T12:00:00.000Z",
  "event_type": "message_completed",
  "session_id": "abc-123",
  "project_key": "channel-id:agentName",
  "project_dir": "/path/to/project",
  "agent_target": "engineer",
  "input_tokens": 15000,
  "output_tokens": 3200,
  "cache_creation_input_tokens": 5000,
  "cache_read_input_tokens": 8000,
  "total_cost_usd": 0.042,
  "duration_ms": 45000,
  "duration_api_ms": 38000,
  "num_turns": 12,
  "model": "claude-sonnet-4-20250514"
}
```

### Emission Point

Emitted from `session-manager.ts` after `runClaude()` returns successfully, when `result.usage` is present.

---

## 3. Activity Engine

**New file**: `src/activity-engine.ts`

Reads `~/.pulse/events/mpg-sessions.jsonl` directly (no external CLI), parses events, filters by time range, and computes aggregations.

### Interface

```typescript
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

export type TimeRange = '24h' | '7d' | '30d';
export type Bucket = 'hour' | 'day';

export function createActivityEngine(filePath?: string): ActivityEngine;
```

### Data Types

```typescript
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
  bucket: string;    // ISO date string for the bucket start
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
  cacheHitRatio: number;   // cacheReadTokens / totalInputTokens, or 0
}
```

### Behavior

- Reads the JSONL file synchronously on each call (file is append-only, small enough for in-memory processing)
- Filters events by timestamp using the time range (24h → last 24 hours, 7d → last 7 days, 30d → last 30 days)
- `summaryCards()`: Aggregates across `session_start`, `session_end`, `session_idle`, and `message_completed` events
  - `totalSessions` = count of `session_start` events
  - `totalMessages` = count of `message_completed` events
  - `totalCostUsd` = sum of `total_cost_usd` from `message_completed`
  - `totalInputTokens` / `totalOutputTokens` = sum from `message_completed`
  - `avgSessionDurationMs` = average `duration_ms` from `session_end` + `session_idle` events
- `sessionsOverTime(bucket)` / `messagesOverTime(bucket)` / `costOverTime(bucket)`: Groups events into time buckets
  - Bucket `hour` for 24h range, `day` for 7d/30d
  - Returns array of `{ bucket: "2026-03-27T14:00:00.000Z", value: N }`
- `tokensByProject()`: Groups `message_completed` events by `project_key`
- `tokensBySession()`: Groups `message_completed` events by `session_id`
- `modelBreakdown()`: Groups `message_completed` events by `model` field
- `cacheEfficiency()`: Computes cache hit ratio from `message_completed` events
- `sessionDurations()`: Returns duration for each session from `session_end`/`session_idle` events
- Default file path: `~/.pulse/events/mpg-sessions.jsonl`
- Graceful on missing file: returns zero/empty results
- `createActivityEngine` accepts optional override path for testing

---

## 4. API Endpoints

**Modified file**: `src/health-server.ts`

### Changes

Remove `defaultRunPulseCli`, `HealthServerOptions.runPulseCli`, and pulse CLI references. Replace with activity engine.

Update `HealthServerOptions`:

```typescript
export interface HealthServerOptions {
  activityEngine?: ActivityEngine;
}
```

### Updated Endpoints

#### `GET /api/activity/summary`

Query params (all optional):
- `range` — `24h`, `7d`, `30d`. Default: `7d`
- `project` — filter by project key

Implementation calls `activityEngine` methods directly:

```typescript
const range = (url.searchParams.get('range') as TimeRange) || '7d';
const project = url.searchParams.get('project') || undefined;
const bucket: Bucket = range === '24h' ? 'hour' : 'day';

const summary = engine.summaryCards(range, project);
const sessionsOverTime = engine.sessionsOverTime(range, bucket);
const messagesOverTime = engine.messagesOverTime(range, bucket);
const costOverTime = engine.costOverTime(range, bucket);
const tokensByProject = engine.tokensByProject(range);
const tokensBySession = engine.tokensBySession(range, project);
const modelBreakdown = engine.modelBreakdown(range);
const cacheEfficiency = engine.cacheEfficiency(range, project);
const sessionDurations = engine.sessionDurations(range, project);
```

Returns:
```json
{
  "summary": { "totalCostUsd": 1.23, "totalInputTokens": 500000, "..." : "..." },
  "sessionsOverTime": [{ "bucket": "...", "value": 5 }],
  "messagesOverTime": [{ "bucket": "...", "value": 42 }],
  "costOverTime": [{ "bucket": "...", "value": 0.15 }],
  "tokensByProject": [{ "projectKey": "...", "..." : "..." }],
  "tokensBySession": [{ "sessionId": "...", "..." : "..." }],
  "modelBreakdown": [{ "model": "...", "..." : "..." }],
  "cacheEfficiency": { "totalInputTokens": 500000, "cacheReadTokens": 200000, "cacheHitRatio": 0.4 },
  "sessionDurations": [{ "sessionId": "...", "durationMs": 45000 }]
}
```

#### `GET /api/activity/sessions` (kept for backward compatibility)

Same data source, returns filtered events list. Can be simplified or removed later.

### Graceful Degradation

If JSONL file doesn't exist or is empty, return 200 with zero-value summary and empty arrays. No `pulse_available` flag needed — the engine always works.

---

## 5. Dashboard Activity Tab

**Modified file**: `src/health-server.ts` (embedded HTML)

### Layout

Tabbed navigation (existing):
- **Overview** tab (existing content)
- **Activity** tab (redesigned)

### Activity Tab Content

#### Summary Cards (top row, 5 cards)

| Card | Data Source | Format |
|------|-----------|--------|
| Total Cost | `summary.totalCostUsd` | `$X.XX` |
| Total Tokens | `summary.totalInputTokens + summary.totalOutputTokens` | `X.Xk` or `X.XM` |
| Total Sessions | `summary.totalSessions` | integer |
| Total Messages | `summary.totalMessages` | integer |
| Avg Session Duration | `summary.avgSessionDurationMs` | `Xm Ys` |

#### Charts (2×3 grid)

| Position | Chart | Type | Data Source |
|----------|-------|------|-------------|
| 1,1 | Messages Over Time | Bar | `messagesOverTime` |
| 1,2 | Cost Over Time | Line | `costOverTime` |
| 1,3 | Sessions Over Time | Bar | `sessionsOverTime` |
| 2,1 | Token Usage Over Time | Stacked Bar | Derived: input vs output from `message_completed` events bucketed |
| 2,2 | Persona Breakdown | Doughnut | Derived from `message_completed` agent_target grouping |
| 2,3 | Model Breakdown | Doughnut | `modelBreakdown` |

#### Tables (below charts)

1. **Token Usage by Project** — columns: Project, Input Tokens, Output Tokens, Cache Read, Cost, Messages
   - Data: `tokensByProject`

2. **Token Usage by Session** — columns: Session, Project, Input Tokens, Output Tokens, Cost, Messages, Duration
   - Data: `tokensBySession`

3. **Cache Efficiency** — single row: Total Input Tokens, Cache Read Tokens, Cache Creation Tokens, Hit Ratio
   - Data: `cacheEfficiency`

#### Range Selector

Buttons: **24h** / **7d** / **30d** — re-fetches `/api/activity/summary?range=X` on click.

#### Removed

- Pulse CLI warning banner (`pulse_available` flag)
- Peak Concurrency chart (not available without pulse CLI)
- Duration Stats table (replaced by Session table with duration column)

### Styling

Follow existing dark theme. Chart.js configured with:
- Dark background (transparent canvas, matching `#0f1117`)
- Light grid lines (`#30363d`)
- Green/blue/purple color palette matching existing status colors

### Refresh

- Fetches on tab switch and every 30s
- Bucket selection automatic: `hour` for 24h, `day` for 7d/30d

---

## 6. Data Capture Changes

### `parseClaudeJsonOutput` Updates

Extend to extract `ClaudeUsage` from Claude CLI's `--output-format json` response:

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

### Session Manager `message_completed` Emission

In `session-manager.ts`, after `runClaude()` returns successfully and `result.usage` is present:

```typescript
if (pulseEmitter && session.sessionId && result.usage) {
  pulseEmitter.messageCompleted(
    session.sessionId,
    session.projectKey,
    session.cwd,
    result.usage,
    { agentTarget: /* extracted from prompt or config */ },
  );
}
```

---

## 7. Testing Strategy

### Unit Tests

- **`tests/claude-cli.test.ts`**: Test `parseClaudeJsonOutput` extracts `ClaudeUsage` from sample Claude CLI JSON output. Test graceful handling when usage fields are missing.
- **`tests/pulse-events.test.ts`**: Add test for `messageCompleted` event — verify it writes correct JSON with all usage fields.
- **`tests/activity-engine.test.ts`**: **New** — Test each aggregation method against a fixture JSONL file with known events. Test time range filtering. Test empty/missing file handling. Test bucketing logic.
- **`tests/session-manager.test.ts`**: Add test verifying `message_completed` is emitted after successful `runClaude` with usage data.
- **`tests/health-server.test.ts`**: Update activity endpoint tests to use mock `ActivityEngine` instead of `runPulseCli`.

### No E2E Test for Dashboard Charts

Chart.js rendering is client-side and not testable in Vitest. Manual verification is sufficient.

---

## 8. Files Changed

| File | Change |
|------|--------|
| `src/claude-cli.ts` | Add `ClaudeUsage` interface, extend `ClaudeResult`, update `parseClaudeJsonOutput` |
| `src/pulse-events.ts` | Add `messageCompleted` method to `PulseEmitter` |
| `src/activity-engine.ts` | **New** — JSONL reader + aggregation engine |
| `src/session-manager.ts` | Emit `message_completed` after `runClaude()` |
| `src/health-server.ts` | Replace pulse CLI proxy with activity engine, update dashboard Activity tab |
| `src/cli.ts` | Wire up `createActivityEngine()` and pass to health server |
| `tests/claude-cli.test.ts` | Add usage extraction tests |
| `tests/pulse-events.test.ts` | Add `messageCompleted` tests |
| `tests/activity-engine.test.ts` | **New** — activity engine unit tests |
| `tests/session-manager.test.ts` | Add `message_completed` emission test |
| `tests/health-server.test.ts` | Update to use mock activity engine |

---

## 9. Phasing

**Single PR** with commits per task:
1. Extend `ClaudeResult` + add `message_completed` pulse event
2. Build activity engine
3. Hook `message_completed` into session manager
4. Update API endpoints to use activity engine
5. Update dashboard Activity tab
6. Wire up in CLI, final verification
