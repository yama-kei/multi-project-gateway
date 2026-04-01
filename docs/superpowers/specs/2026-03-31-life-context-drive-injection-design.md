# Life Context Drive Injection

**Date:** 2026-03-31
**Status:** Approved
**Issue:** #160 (comment) — life-context agents cannot find Drive data

## Problem

Life-context topic agents (life-work, life-travel, life-social, life-hobbies) have system prompts stating "Your knowledge comes from curated context files in Google Drive under /life-context/{topic}/" but have no mechanism to actually read from Drive. They are Claude CLI sessions with only standard file tools (Read, Glob, Grep, etc.). The curator pipeline has already populated Drive with Q1 2026 data, but agents cannot access it.

## Solution

Pre-fetch Drive context via the broker client and inject it into the agent's system prompt at dispatch time.

## Architecture

### New module: `src/life-context-loader.ts`

Single async function:

```ts
loadLifeContext(agentName: string): Promise<string | null>
```

Behavior:
1. Maps agent name to topic: `life-work` → `work`, `life-travel` → `travel`, `life-social` → `social`, `life-hobbies` → `hobbies`
2. Returns `null` for non-life-context agents (`life-router`, `curator`, `pm`, etc.)
3. Creates broker client lazily via `createBrokerClientFromEnv()`, cached as module-level singleton
4. Loads `folder-map.json` via `driveSearch` → `driveRead` to get topic folder ID
5. Lists files in the topic folder via `driveList`
6. Reads each file via `driveRead`
7. Returns formatted context string

### Injected context format

```
--- LIFE CONTEXT DATA ---

## summary.md
<file content>

## timeline.md
<file content>

## entities.md
<file content>

--- END LIFE CONTEXT DATA ---
```

### Integration in `src/discord.ts`

Two injection points where system prompts are built:

1. **Initial agent dispatch** (~line 365): where `systemPrompt` is constructed from `activeAgent`
2. **Handoff dispatch** (~line 465): where `handoffPrompt` is constructed from `handoff.agent`

Both become async — call `loadLifeContext(agentName)` and append the result to the system prompt if non-null.

### Error handling

| Scenario | Behavior |
|---|---|
| Broker env vars missing | Returns `null`, logs one-time warning. Agent works without Drive context. |
| Broker unreachable / API error | Returns `null`, logs error. Agent responds without context (same as today). |
| `folder-map.json` not found | Returns `null` (curator hasn't run yet). |
| Topic folder empty | Returns `null`. |

No caching across requests — each dispatch fetches fresh from Drive so context stays up-to-date as the curator writes new data. Broker calls are lightweight (3-4 small markdown file reads).

## Scope boundaries

- No changes to the curator pipeline
- No changes to agent system prompt wording (beyond appending context)
- No caching layer
- No changes to `life-router` (dispatches only, doesn't need Drive context)

## Files touched

| File | Change |
|---|---|
| `src/life-context-loader.ts` | New — loader function |
| `src/discord.ts` | Modified — call loader at both dispatch points |
| `tests/life-context-loader.test.ts` | New — unit tests |
