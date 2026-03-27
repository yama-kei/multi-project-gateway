# Pulse Activity Integration — Design Spec

**Issue**: #64 — Add session activity monitor and graphs to web dashboard
**Date**: 2026-03-27
**Approach**: Thin Proxy — MPG writes JSONL events, shells out to pulse CLI for reads

---

## Architecture Overview

```
Discord → Session Manager → pulse-events.ts → ~/.pulse/events/mpg-sessions.jsonl
                                                         ↑
Dashboard UI ← /api/activity/* ← health-server.ts ← `pulse activity --json` CLI
```

MPG is a **producer** (writes events) and a **proxy** (forwards pulse CLI output to dashboard). Pulse owns the schema, aggregation logic, and file format. Zero library coupling between projects.

---

## 1. Event Emitter Module

**New file**: `src/pulse-events.ts`

### Interface

```typescript
export interface PulseEmitter {
  sessionStart(sessionId: string, projectKey: string, projectDir: string, opts?: { agentName?: string; triggerSource?: string }): void;
  sessionEnd(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionIdle(sessionId: string, projectKey: string, projectDir: string, durationMs: number, messageCount: number): void;
  sessionResume(sessionId: string, projectKey: string, projectDir: string, idleDurationMs: number): void;
  messageRouted(sessionId: string, projectKey: string, projectDir: string, opts?: { agentTarget?: string; queueDepth?: number }): void;
}

export function createPulseEmitter(filePath?: string): PulseEmitter;
```

### Behavior

- Each method constructs a JSON object matching pulse's `SessionEvent` schema (`schema_version: 1`, ISO timestamp, event_type, session_id, project_key, project_dir, plus per-type fields).
- Appends a single JSON line + `\n` to the JSONL file using `fs.appendFileSync`.
- **Fire-and-forget**: All writes are wrapped in try/catch. Failures log a warning via the project logger but never throw. The gateway must not crash because of event logging.
- Default file path: `~/.pulse/events/mpg-sessions.jsonl`. Directory created on first write if missing (`mkdirSync recursive`).
- `createPulseEmitter` accepts an optional override path for testing.

### Schema (matches pulse's `SessionEvent` types)

All events share these base fields:
```json
{
  "schema_version": 1,
  "timestamp": "2026-03-27T12:00:00.000Z",
  "event_type": "session_start|session_end|session_idle|session_resume|message_routed",
  "session_id": "abc-123",
  "project_key": "channel-id-or-threadId:agentName",
  "project_dir": "/path/to/project"
}
```

Per-type extras:
| Event | Extra Fields |
|-------|-------------|
| `session_start` | `agent_name?: string`, `trigger_source: string` |
| `session_end` | `duration_ms: number`, `message_count: number` |
| `session_idle` | `duration_ms: number`, `message_count: number` |
| `session_resume` | `idle_duration_ms: number` |
| `message_routed` | `agent_target?: string`, `queue_depth: number` |

---

## 2. Session Manager Hooks

**Modified file**: `src/session-manager.ts`

The `createSessionManager` function gains a new optional parameter: `pulseEmitter?: PulseEmitter`.

### Hook Points

| Lifecycle Point | Event | Where in Code |
|----------------|-------|---------------|
| New session created | `session_start` | `getOrCreateSession()` — when a brand-new session is created (not restored from store) |
| Session restored from store | `session_resume` | `getOrCreateSession()` — when restoring a persisted session (idle_duration = now - lastActivity) |
| Message dispatched | `message_routed` | `processQueue()` — just before `runClaude()` call |
| Session goes idle | `session_idle` | `resetIdleTimer()` callback — when the idle timer fires and removes session from memory |
| Session killed | `session_end` | `clearSession()` — explicit termination |

### Message Count Tracking

Add a `messageCount: number` field to `InternalSession`. Increment on each successful `runClaude()` call. Used by `session_idle` and `session_end` events.

### Duration Tracking

Add a `createdAt: number` field to `InternalSession` (set once at creation time). Duration = `Date.now() - createdAt`.

---

## 3. API Endpoints

**Modified file**: `src/health-server.ts`

### New Endpoints

#### `GET /api/activity/sessions`

Query params (all optional, forwarded as CLI flags):
- `range` — time range (e.g., `24h`, `7d`, `30d`). Default: `7d`
- `project` — filter by project key
- `type` — filter by event type

Implementation:
```typescript
execFile('pulse', ['activity', 'sessions', '--json', '--range', range, ...])
```

Returns: pulse's `ActivitySessions` JSON directly, or fallback:
```json
{ "source": "mpg-sessions", "filters": {}, "events": [], "pulse_available": false }
```

#### `GET /api/activity/summary`

Query params (all optional):
- `range` — time range. Default: `7d`
- `project` — filter by project key
- `bucket` — aggregation bucket (`hour`, `day`, `week`). Default: `day`

Implementation:
```typescript
execFile('pulse', ['activity', 'summary', '--json', '--range', range, '--bucket', bucket, ...])
```

Returns: pulse's `ActivitySummary` JSON directly, or fallback:
```json
{
  "source": "mpg-sessions", "filters": {}, "bucket": "day",
  "sessions_per_bucket": [], "duration_stats": [], "message_volume": [],
  "persona_breakdown": [], "peak_concurrent": [],
  "pulse_available": false
}
```

### Graceful Degradation

Both endpoints catch `ENOENT` (pulse not on PATH) and exec errors. On failure:
- Return 200 with empty data + `pulse_available: false` flag
- Log a warning once (not on every request)

### Helper Function

```typescript
function runPulseCli(args: string[]): Promise<string>
```
- Uses `child_process.execFile` (not `exec`) — no shell injection risk
- 10-second timeout to prevent hangs
- Returns stdout on success, throws on failure

---

## 4. Dashboard UI

**Modified file**: `src/health-server.ts` (embedded HTML)

### Layout Changes

Add a tabbed navigation to the dashboard:
- **Overview** tab (existing content: status cards, sessions table, projects table)
- **Activity** tab (new: charts and breakdowns)

### Chart.js Integration

Load Chart.js via CDN in the `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
```

### Activity Tab Content

1. **Sessions Over Time** (bar chart)
   - Data from `/api/activity/summary` → `sessions_per_bucket`
   - X-axis: time buckets, Y-axis: session count
   - Stacked by project if multiple projects

2. **Message Volume** (line chart)
   - Data from `message_volume`
   - Same axes as sessions chart

3. **Duration Stats** (table)
   - Data from `duration_stats`
   - Columns: Project, Avg, Median, P95

4. **Persona Breakdown** (doughnut chart)
   - Data from `persona_breakdown`
   - Shows agent usage distribution

5. **Peak Concurrency** (line chart)
   - Data from `peak_concurrent`
   - X-axis: time buckets, Y-axis: max concurrent

### Activity Refresh

- Fetches `/api/activity/summary?range=7d&bucket=day` on tab switch and every 30s (slower than the 5s status refresh — activity data changes slowly)
- Range selector: buttons for 24h / 7d / 30d that re-fetch with the selected range
- If `pulse_available === false`, show a notice: "Install pulse CLI for activity graphs"

### Styling

Follow existing dark theme. Chart.js configured with:
- Dark background (transparent canvas, matching `#0f1117`)
- Light grid lines (`#30363d`)
- Green/blue/purple color palette matching existing status colors

---

## 5. Testing Strategy

### Unit Tests

- **`tests/pulse-events.test.ts`**: Test each emitter method writes correct JSON to a temp file. Test fire-and-forget (invalid path doesn't throw). Test directory creation.
- **`tests/session-manager.test.ts`**: Add tests verifying pulse events are emitted at correct lifecycle points (using a mock emitter).
- **`tests/health-server.test.ts`**: Add tests for `/api/activity/*` endpoints — mock `execFile` to return sample pulse output, test graceful degradation when pulse is unavailable.

### No E2E Test for Dashboard Charts

Chart.js rendering is client-side and not testable in Vitest. Manual verification is sufficient for the initial implementation.

---

## 6. Files Changed

| File | Change |
|------|--------|
| `src/pulse-events.ts` | **New** — event emitter module |
| `src/session-manager.ts` | Add pulse hooks, message counter, created timestamp |
| `src/health-server.ts` | Add `/api/activity/*` endpoints, activity tab in dashboard |
| `src/cli.ts` | Wire up `createPulseEmitter()` and pass to session manager |
| `tests/pulse-events.test.ts` | **New** — emitter unit tests |
| `tests/session-manager.test.ts` | Add pulse event emission tests |
| `tests/health-server.test.ts` | Add activity endpoint tests |

---

## 7. Phasing

**Phase 1** (single PR): Event emitter + session manager hooks + API endpoints + tests
**Phase 2** (follow-up commit in same PR): Dashboard UI with Chart.js

This lets us verify the data pipeline works before building visuals on top, per PM's suggestion.
