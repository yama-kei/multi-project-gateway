# Activity Dashboard: Token Usage & Session Metrics

## Problem

MPG has no visibility into agent resource consumption. The existing Activity tab depends on an external `pulse` CLI that may not be installed, and tracks only session/message counts — no token usage, cost, or duration data. Operators need to understand how much activity is happening across projects and sessions to make informed decisions about usage.

## Goals

- Show token usage (input/output) and cost (USD) per project and per session
- Show session execution durations
- Show message volume and session counts over time
- Eliminate the external `pulse` CLI dependency — read JSONL directly
- Present all metrics in the existing `:3100` Activity tab with predefined time ranges (24h / 7d / 30d)

## Non-Goals

- Per-user breakdowns
- Custom date range pickers
- Real-time streaming updates
- Historical data migration (new events only)

---

## Design

### 1. Data Capture

#### 1.1 Extend `ClaudeResult` (`src/claude-cli.ts`)

Add usage fields to the result interface, extracted from the CLI's `--output-format json` response:

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
  usage?: ClaudeUsage;  // NEW — undefined if CLI doesn't provide it
}
```

`parseClaudeJsonOutput` extracts from the existing JSON fields:
- `data.usage.input_tokens`, `data.usage.output_tokens`, `data.usage.cache_creation_input_tokens`, `data.usage.cache_read_input_tokens`
- `data.total_cost_usd`
- `data.duration_ms`, `data.duration_api_ms`
- `data.num_turns`
- First key of `data.modelUsage` for the model name

#### 1.2 New Pulse Event: `message_completed` (`src/pulse-events.ts`)

Emitted after Claude CLI returns successfully. Carries the usage payload:

```typescript
messageCompleted(
  sessionId: string,
  projectKey: string,
  projectDir: string,
  usage: ClaudeUsage,
  opts?: { agentTarget?: string }
): void;
```

Event shape in JSONL:
```json
{
  "schema_version": 1,
  "timestamp": "2026-03-27T10:00:00.000Z",
  "event_type": "message_completed",
  "session_id": "abc123",
  "project_key": "1234567890",
  "project_dir": "/home/user/myproject",
  "agent_target": "engineer",
  "input_tokens": 1500,
  "output_tokens": 800,
  "cache_creation_input_tokens": 5000,
  "cache_read_input_tokens": 12000,
  "total_cost_usd": 0.045,
  "duration_ms": 3200,
  "duration_api_ms": 3100,
  "num_turns": 1,
  "model": "claude-opus-4-6[1m]"
}
```

Existing events (`session_start`, `session_end`, `session_idle`, `session_resume`, `message_routed`) remain unchanged.

#### 1.3 Emission Point

In `src/discord.ts` (or wherever `runClaude` is called), after a successful CLI call:

```typescript
const result = await runClaude(...);
if (result.usage) {
  pulse.messageCompleted(sessionId, projectKey, projectDir, result.usage, { agentTarget });
}
```

---

### 2. Activity Engine (`src/activity-engine.ts`)

New module that replaces the `pulse` CLI dependency. Reads the JSONL file directly and computes aggregations in-process.

#### 2.1 JSONL Reader

```typescript
interface PulseEvent {
  schema_version: number;
  timestamp: string;
  event_type: string;
  session_id: string;
  project_key: string;
  project_dir: string;
  [key: string]: unknown;
}

function readEvents(filePath: string, rangeMs: number): PulseEvent[]
```

- Reads the file line-by-line
- Parses each line as JSON
- Filters to events within `Date.now() - rangeMs`
- Skips malformed lines silently (fire-and-forget philosophy)

#### 2.2 Aggregation Functions

All functions take a filtered `PulseEvent[]` and return plain objects suitable for JSON serialization.

**`computeSummary(events)`** returns:
```typescript
{
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_sessions: number;
  total_messages: number;
  avg_session_duration_ms: number;
}
```

**`tokensByProject(events)`** returns:
```typescript
Array<{
  project_key: string;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  message_count: number;
}>
```

**`tokensBySession(events)`** returns:
```typescript
Array<{
  session_id: string;
  project_key: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  message_count: number;
  duration_ms: number;
}>
```

**`bucketed(events, eventType, bucket, valueField?)`** — generic bucketing:
- Groups events of `eventType` by time bucket (`hour` or `day`)
- If `valueField` provided, sums that field; otherwise counts occurrences
- Returns `Array<{ bucket: string; value: number }>`

Used for: sessions over time, messages over time, cost over time, tokens over time.

**`sessionDurations(events)`** returns:
```typescript
Array<{
  session_id: string;
  project_key: string;
  duration_ms: number;
}>
```
Derived from `session_end` and `session_idle` events.

**`modelBreakdown(events)`** returns:
```typescript
Array<{
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}>
```

**`personaBreakdown(events)`** returns:
```typescript
Array<{
  agent: string;  // agent_target or "default"
  count: number;
}>
```
Derived from `message_routed` events, grouped by `agent_target`.

**`cacheEfficiency(events)`** returns:
```typescript
{
  total_input_tokens: number;
  cache_read_tokens: number;
  cache_hit_ratio: number;  // 0-1
}
```

#### 2.3 Time Ranges & Bucketing

| Range | `rangeMs` | Bucket | Label Format |
|-------|-----------|--------|--------------|
| 24h | 86,400,000 | hour | `HH:00` |
| 7d | 604,800,000 | day | `MM-DD` |
| 30d | 2,592,000,000 | day | `MM-DD` |

---

### 3. API Changes (`src/health-server.ts`)

#### 3.1 Replace Pulse CLI Integration

Remove:
- `HealthServerOptions.runPulseCli`
- `defaultRunPulseCli` function
- `execFile('pulse', ...)` calls

Add:
- Import `activity-engine` functions
- Read the JSONL path from config or use default `~/.pulse/events/mpg-sessions.jsonl`

#### 3.2 Updated `/api/activity/summary` Response

The endpoint keeps the same URL but returns a richer payload:

```json
{
  "summary": {
    "total_cost_usd": 12.45,
    "total_input_tokens": 450000,
    "total_output_tokens": 120000,
    "total_sessions": 34,
    "total_messages": 156,
    "avg_session_duration_ms": 480000
  },
  "tokens_by_project": [...],
  "tokens_by_session": [...],
  "sessions_over_time": [...],
  "messages_over_time": [...],
  "cost_over_time": [...],
  "tokens_over_time": [...],
  "session_durations": [...],
  "model_breakdown": [...],
  "cache_efficiency": {...},
  "persona_breakdown": [...]
}
```

The old fields (`sessions_per_bucket`, `duration_stats`, `message_volume`, `peak_concurrent`, `persona_breakdown`) are replaced by the new structure.

---

### 4. Dashboard UI (`src/health-server.ts` — `buildDashboardHtml`)

#### 4.1 Summary Cards (top of Activity tab)

Five cards in a row:
- **Total Cost** — `$X.XX`
- **Total Tokens** — `X.Xk` or `X.XM` (input + output)
- **Total Sessions** — count
- **Total Messages** — count
- **Avg Duration** — `Xm` or `Xh Ym`

#### 4.2 Charts (2x3 grid)

1. **Messages Over Time** — bar chart, bucketed message counts
2. **Cost Over Time** — line chart, USD per bucket
3. **Sessions Over Time** — bar chart, session starts per bucket
4. **Token Usage Over Time** — stacked bar chart (input tokens vs output tokens per bucket)
5. **Persona Breakdown** — doughnut chart (messages per agent)
6. **Model Breakdown** — doughnut chart (cost per model)

All charts use Chart.js (already loaded via CDN). Colors follow existing `CHART_COLORS` palette.

#### 4.3 Tables (below charts)

**Token Usage by Project:**
| Project | Input Tokens | Output Tokens | Cache Read | Cost | Messages |
|---------|-------------|--------------|------------|------|----------|

**Token Usage by Session:**
| Session | Project | Input | Output | Cost | Messages | Duration |
|---------|---------|-------|--------|------|----------|----------|

**Cache Efficiency:**
| Total Input Tokens | Cache Read Tokens | Hit Ratio |
|-------------------|-------------------|-----------|

#### 4.4 Removed

- `pulse-warning` banner
- `defaultRunPulseCli` function and `HealthServerOptions.runPulseCli`
- Peak Concurrency chart (replaced by more useful token/cost charts)

---

## Files Changed

| File | Change |
|------|--------|
| `src/claude-cli.ts` | Add `ClaudeUsage` interface; extend `ClaudeResult`; update `parseClaudeJsonOutput` |
| `src/pulse-events.ts` | Add `messageCompleted` method to `PulseEmitter` |
| `src/activity-engine.ts` | **New** — JSONL reader + aggregation functions |
| `src/health-server.ts` | Replace pulse CLI with activity engine; update API response; rebuild Activity tab HTML/JS |
| `src/discord.ts` | Emit `messageCompleted` after successful `runClaude` calls |
| `tests/activity-engine.test.ts` | **New** — unit tests for reader + aggregation |
| `tests/claude-cli.test.ts` | Update for new `ClaudeResult.usage` field |
| `tests/pulse-events.test.ts` | Add `messageCompleted` tests |
| `tests/health-server.test.ts` | Update for new API response shape |

## Testing Strategy

- **Unit tests** for activity-engine: feed synthetic JSONL, verify aggregation math
- **Unit tests** for parseClaudeJsonOutput: verify usage extraction from sample CLI output
- **Integration test** for health-server: mock JSONL file, verify `/api/activity/summary` returns correct shape
- **Existing tests** updated for new `ClaudeResult` shape (add `usage: undefined` where needed)
