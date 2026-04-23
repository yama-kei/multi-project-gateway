# Pulse Enrichment Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich `message_completed` events on-read with two heuristic signals (`turn_complexity`, `retry_count`) inside `src/activity-engine.ts`, and surface them on the activity dashboard.

**Architecture:** Pure on-read enrichment — no changes to the emit path (`src/pulse-events.ts`) or on-disk schema. New `ActivityEngine` methods compute enrichment from existing `message_completed` / `message_routed` event fields. Dashboard consumes via the existing `/api/activity/summary` endpoint. All new fields are commented as "Phase 1 heuristic" so Phase 2 (LLM enrichment) can swap them.

**Tech Stack:** TypeScript, vitest, Chart.js (for dashboard).

---

## Scope

**In scope:**
- `turn_complexity` per `message_completed` event: bucket `low` / `medium` / `high` derived from `num_turns` and `duration_ms`.
- `retry_count` per session: count of `message_routed` events that were not preceded by a successful agent turn since the previous `message_routed` in the same session. "Successful agent turn" = `message_completed` with non-zero `output_tokens`.
- Dashboard surfacing: retry-rate per agent table, and turn-complexity breakdown card.

**Out of scope (Phase 2, separate issue):** `user_correction`, `intent`, `work_type` — these need transcript/tool-call metadata not carried in current events.

## File Structure

- **Modify:** `src/activity-engine.ts:75-134` — extend `ActivityEngine` interface with `turnComplexity` and `sessionRetries`; add implementations around `src/activity-engine.ts:195-220`.
- **Modify:** `tests/activity-engine.test.ts` — add `describe` blocks for both new methods.
- **Modify:** `src/dashboard-server.ts:977-993` — extend `/api/activity/summary` payload with `turn_complexity` and `session_retries`.
- **Modify:** `src/dashboard-server.ts:110-138` (activity-tab HTML) — add two new sections (a complexity card + a retry-rate table).
- **Modify:** `src/dashboard-server.ts:689-807` (inline `refreshActivity()`) — render the two new sections.

## Heuristic definitions (Phase 1)

### `turn_complexity`

Bucketed from `num_turns` and `duration_ms` on `message_completed`:

```typescript
// Phase 1 heuristic: bucket based on response "size".
// num_turns counts Claude's internal conversational turns (tool-use roundtrips).
// duration_ms is wall-clock; reflects how long Claude took to answer.
// Thresholds are heuristic starting points; revisit once Phase 2 LLM labels exist.
function classifyComplexity(numTurns: number, durationMs: number): 'low' | 'medium' | 'high' {
  if (numTurns >= 10 || durationMs >= 120_000) return 'high';
  if (numTurns <= 3 && durationMs < 30_000) return 'low';
  return 'medium';
}
```

### `retry_count`

Per session, count `message_routed` events where there was a prior `message_routed` in the same session, and between them there was **no** `message_completed` with non-zero `output_tokens`. "Successful agent turn" is defined by non-zero output_tokens because that's the clearest signal available — an empty completion means the agent returned nothing useful.

---

## Task 1: `turnComplexity` method

**Files:**
- Modify: `src/activity-engine.ts` (add method + classify helper)
- Modify: `tests/activity-engine.test.ts` (add `describe('turnComplexity', ...)`)

- [ ] **Step 1: Add the interface signature to `ActivityEngine`**

In `src/activity-engine.ts`, add to the `ActivityEngine` interface (near line ~121 alongside `cacheEfficiency`):

```typescript
/** Phase 1 heuristic: bucketed count of message_completed events by turn_complexity.
 *  Swap for Phase 2 LLM-derived complexity labels when available. */
turnComplexity(range: TimeRange): {
  low: number;
  medium: number;
  high: number;
};
```

- [ ] **Step 2: Write the failing test**

Add to `tests/activity-engine.test.ts`:

```typescript
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
      makeEvent({ event_type: 'message_completed' }), // no fields → 0/0 → low
    ]);
    const engine = createActivityEngine(filePath);
    const c = engine.turnComplexity('7d');
    expect(c.low).toBe(1);
    expect(c.medium).toBe(0);
    expect(c.high).toBe(0);
  });

  it('returns zero counts for missing file', () => {
    const engine = createActivityEngine(join(dir, 'nonexistent.jsonl'));
    const c = engine.turnComplexity('7d');
    expect(c).toEqual({ low: 0, medium: 0, high: 0 });
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/activity-engine.test.ts -t turnComplexity
```

Expected: FAIL — `engine.turnComplexity is not a function`.

- [ ] **Step 4: Implement the method**

Add the `classifyComplexity` helper near the top of `src/activity-engine.ts` (after `bucketKey`):

```typescript
/** Phase 1 heuristic: classify a message_completed event as low/medium/high turn_complexity.
 *  Thresholds are chosen to separate quick single-turn replies from deeper multi-tool work.
 *  Revisit once Phase 2 LLM labels are available. */
function classifyComplexity(numTurns: number, durationMs: number): 'low' | 'medium' | 'high' {
  if (numTurns >= 10 || durationMs >= 120_000) return 'high';
  if (numTurns <= 3 && durationMs < 30_000) return 'low';
  return 'medium';
}
```

Add the method implementation in the returned object (alongside `cacheEfficiency`):

```typescript
turnComplexity(range) {
  const messages = getEvents(range, 'message_completed');
  const counts = { low: 0, medium: 0, high: 0 };
  for (const e of messages) {
    const bucket = classifyComplexity(Number(e.num_turns) || 0, Number(e.duration_ms) || 0);
    counts[bucket]++;
  }
  return counts;
},
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/activity-engine.test.ts -t turnComplexity
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/activity-engine.ts tests/activity-engine.test.ts
git commit -m "feat(pulse): add turnComplexity enrichment to ActivityEngine"
```

---

## Task 2: `sessionRetries` method

**Files:**
- Modify: `src/activity-engine.ts`
- Modify: `tests/activity-engine.test.ts`

- [ ] **Step 1: Add the interface signature**

In `src/activity-engine.ts`, add to the `ActivityEngine` interface:

```typescript
/** Phase 1 heuristic: per-session retry counts based on the pattern
 *  "user message_routed not separated from previous message_routed by a
 *  message_completed with non-zero output_tokens". */
sessionRetries(range: TimeRange): Array<{
  session_id: string;
  project_key: string;
  agent: string;
  user_turns: number;
  retries: number;
}>;
```

- [ ] **Step 2: Write the failing test**

Add to `tests/activity-engine.test.ts`:

```typescript
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
      // user turn 1 — no completion after it
      makeEvent({ event_type: 'message_routed', session_id: 'sess-retry', timestamp: t(1000) }),
      // user turn 2 — retry of turn 1
      makeEvent({ event_type: 'message_routed', session_id: 'sess-retry', timestamp: t(2000) }),
      // user turn 3 — retry of turn 2 (still no successful completion)
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

  it('resolves agent from session_start agent_name, falls back to agent_target on message_routed', () => {
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
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/activity-engine.test.ts -t sessionRetries
```

Expected: FAIL — `engine.sessionRetries is not a function`.

- [ ] **Step 4: Implement the method**

Add to the returned object in `createActivityEngine`:

```typescript
sessionRetries(range) {
  const events = readEvents(target, range);
  // Group relevant events by session_id and sort chronologically.
  const bySession = new Map<string, PulseEvent[]>();
  for (const e of events) {
    if (e.event_type !== 'session_start' && e.event_type !== 'message_routed' && e.event_type !== 'message_completed') continue;
    const list = bySession.get(e.session_id);
    if (list) list.push(e);
    else bySession.set(e.session_id, [e]);
  }

  const rows: Array<{ session_id: string; project_key: string; agent: string; user_turns: number; retries: number }> = [];
  for (const [sessionId, sessEvents] of bySession) {
    sessEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Resolve agent: prefer agent_name on session_start, then agent_target on message_routed.
    let agent = 'default';
    const startEvent = sessEvents.find(e => e.event_type === 'session_start');
    if (startEvent && startEvent.agent_name) {
      agent = String(startEvent.agent_name);
    } else {
      const routedWithTarget = sessEvents.find(e => e.event_type === 'message_routed' && e.agent_target);
      if (routedWithTarget) agent = String(routedWithTarget.agent_target);
    }

    // Walk events. Track whether we've seen a successful completion since the last routed.
    let userTurns = 0;
    let retries = 0;
    let sawSuccessSinceLastRouted = true; // first routed is never a retry
    for (const e of sessEvents) {
      if (e.event_type === 'message_routed') {
        userTurns++;
        if (!sawSuccessSinceLastRouted) retries++;
        sawSuccessSinceLastRouted = false;
      } else if (e.event_type === 'message_completed' && (Number(e.output_tokens) || 0) > 0) {
        sawSuccessSinceLastRouted = true;
      }
    }

    // Only report sessions that had user turns (ignore pure session_start-only rows).
    if (userTurns === 0) continue;

    rows.push({
      session_id: sessionId,
      project_key: sessEvents[0].project_key,
      agent,
      user_turns: userTurns,
      retries,
    });
  }
  return rows;
},
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/activity-engine.test.ts -t sessionRetries
```

Expected: PASS (all sub-tests).

- [ ] **Step 6: Run full activity-engine test file**

```bash
npx vitest run tests/activity-engine.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/activity-engine.ts tests/activity-engine.test.ts
git commit -m "feat(pulse): add sessionRetries enrichment to ActivityEngine"
```

---

## Task 3: Surface new signals through `/api/activity/summary`

**Files:**
- Modify: `src/dashboard-server.ts:954-993` (summary endpoint + empty-response fallback)
- Modify: `tests/dashboard-server.test.ts` (if it tests the payload shape)

- [ ] **Step 1: Check if dashboard-server.test.ts covers the summary endpoint shape**

```bash
grep -n "activity/summary" tests/dashboard-server.test.ts
```

If it covers the shape, update the expected payload. Otherwise, just update the production code.

- [ ] **Step 2: Add new fields to the real payload**

In `src/dashboard-server.ts`, inside the `/api/activity/summary` handler (around line 977), extend `data` with:

```typescript
turn_complexity: engine.turnComplexity(range),
session_retries: engine.sessionRetries(range),
```

- [ ] **Step 3: Add new fields to the empty-engine fallback**

Around line 953-962, extend the default response with:

```typescript
turn_complexity: { low: 0, medium: 0, high: 0 },
session_retries: [],
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/dashboard-server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-server.ts tests/dashboard-server.test.ts
git commit -m "feat(dashboard): expose turn_complexity and session_retries in activity API"
```

---

## Task 4: Render new sections on the Activity tab

**Files:**
- Modify: `src/dashboard-server.ts:110-138` (HTML for Activity tab)
- Modify: `src/dashboard-server.ts:689-807` (inline `refreshActivity()`)

- [ ] **Step 1: Add HTML placeholders for the new sections**

Inside the Activity tab block (after the Cache Efficiency section, around line 138), add:

```html
  <h3 style="margin:16px 0 8px">Turn Complexity (Phase 1 heuristic)</h3>
  <div id="complexity-table"></div>
  <h3 style="margin:16px 0 8px">Retry Rate by Agent (Phase 1 heuristic)</h3>
  <div id="retry-table"></div>
```

- [ ] **Step 2: Render the complexity breakdown in `refreshActivity()`**

At the end of the `.then(function(d) { ... })` block, after the Cache Efficiency table (line ~805), add:

```javascript
      // Turn Complexity breakdown (Phase 1 heuristic)
      var tc = d.turn_complexity || { low: 0, medium: 0, high: 0 };
      var tcTotal = tc.low + tc.medium + tc.high;
      var ctab = document.getElementById('complexity-table');
      if (tcTotal === 0) {
        ctab.innerHTML = '<div class="empty">No data</div>';
      } else {
        var pct = function(n) { return (n / tcTotal * 100).toFixed(1) + '%'; };
        ctab.innerHTML = '<table>' +
          '<tr><th>Bucket</th><th>Count</th><th>Share</th></tr>' +
          '<tr><td>Low (&le;3 turns, &lt;30s)</td><td>' + tc.low + '</td><td>' + pct(tc.low) + '</td></tr>' +
          '<tr><td>Medium</td><td>' + tc.medium + '</td><td>' + pct(tc.medium) + '</td></tr>' +
          '<tr><td>High (&ge;10 turns or &ge;120s)</td><td>' + tc.high + '</td><td>' + pct(tc.high) + '</td></tr>' +
          '</table>';
      }
```

- [ ] **Step 3: Render the retry-rate-by-agent table**

Right after the complexity section, add:

```javascript
      // Retry rate by agent (Phase 1 heuristic) — aggregate per-session rows into per-agent totals
      var byAgent = {};
      (d.session_retries || []).forEach(function(r) {
        var a = r.agent || 'default';
        if (!byAgent[a]) byAgent[a] = { user_turns: 0, retries: 0, sessions: 0 };
        byAgent[a].user_turns += r.user_turns;
        byAgent[a].retries += r.retries;
        byAgent[a].sessions++;
      });
      var rtab = document.getElementById('retry-table');
      var agents = Object.keys(byAgent);
      if (agents.length === 0) {
        rtab.innerHTML = '<div class="empty">No data</div>';
      } else {
        var rh = '<table><tr><th>Agent</th><th>Sessions</th><th>User Turns</th><th>Retries</th><th>Retry Rate</th></tr>';
        agents.sort().forEach(function(a) {
          var row = byAgent[a];
          var rate = row.user_turns > 0 ? (row.retries / row.user_turns * 100).toFixed(1) + '%' : '—';
          rh += '<tr><td>' + escapeHtml(a) + '</td><td>' + row.sessions + '</td><td>' + row.user_turns + '</td><td>' + row.retries + '</td><td>' + rate + '</td></tr>';
        });
        rtab.innerHTML = rh + '</table>';
      }
```

- [ ] **Step 4: Manually inspect the rendered HTML**

Run build and type-check:

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Start the dev server and verify the dashboard**

```bash
npm run dev
```

- Open `http://localhost:<port>/` and switch to the Activity tab.
- Confirm the new "Turn Complexity" and "Retry Rate by Agent" sections render (even "No data" is fine if the local event log is empty).
- Take a screenshot for the PR description.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-server.ts
git commit -m "feat(dashboard): render turn-complexity and retry-rate sections"
```

---

## Task 5: Final verification + PR

- [ ] **Step 1: Run the full test suite**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(pulse): Phase 1 heuristic enrichment — turn_complexity & retry_count (#219)" --body "$(cat <<'EOF'
## Summary
- Adds on-read heuristic enrichment inside `ActivityEngine` for two signals:
  - `turn_complexity` — bucketed `low` / `medium` / `high` per `message_completed`, from `num_turns` + `duration_ms`.
  - `retry_count` — per-session count of `message_routed` events not preceded by a successful agent turn since the previous routed.
- Surfaces both on the Activity tab of the dashboard.
- No changes to `src/pulse-events.ts` emit path; no schema bump; no new files on disk.

## What's deferred
Phase 2 signals (`user_correction`, `intent`, `work_type`) need transcript / tool-call metadata not carried in current events — tracked by a follow-up issue per #219.

## Notes
- Fields are commented as "Phase 1 heuristic" so Phase 2 LLM labels can swap them.
- Thresholds: low = `num_turns <= 3 && duration_ms < 30s`; high = `num_turns >= 10 || duration_ms >= 120s`; else medium.
- "Successful agent turn" = `message_completed` with non-zero `output_tokens`.

## Test plan
- [x] Unit tests for `turnComplexity` cover all three buckets, missing fields, and non-completed events
- [x] Unit tests for `sessionRetries` cover clean sessions, retries, empty completions, agent resolution, and multi-session grouping
- [x] `npm test` green
- [x] `npx tsc --noEmit` clean
- [x] Dashboard manually verified with screenshot attached below
EOF
)"
```

- [ ] **Step 4: Reply in the Discord thread with the PR link**

---

## Self-review

**Spec coverage** — each requirement from the HANDOFF maps to a task:
- New enrichment logic in `src/activity-engine.ts` → Tasks 1, 2.
- Unit tests against fixture JSONL → Tasks 1, 2.
- Dashboard renders retry-rate per agent + turn-complexity → Task 4.
- Fields flagged as "Phase 1 heuristic" → comments in Tasks 1, 2, and 4 labels.
- No persistence (lazy on range query) → implemented as methods that read each call; no caching added.
- All existing tests pass → Task 5.
- PR explanation + screenshot → Task 5.

**Placeholder scan** — no TBDs, all code blocks complete.

**Type consistency** — `turnComplexity` returns object with `low/medium/high`; `sessionRetries` returns array with `session_id / project_key / agent / user_turns / retries`. Dashboard JS keys match: `turn_complexity`, `session_retries`, and field names `user_turns`, `retries`, `agent`.
