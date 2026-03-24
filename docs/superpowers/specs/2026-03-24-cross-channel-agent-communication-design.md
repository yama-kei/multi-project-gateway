# Cross-Channel Agent Communication — Prototype Design

**Date:** 2026-03-24
**Issue:** #38
**Status:** Prototype spec

## Problem

The gateway currently treats each Discord channel as an isolated agent session. There is no way for an agent in one channel (e.g. a PM persona) to delegate work to an agent in another channel (e.g. an Engineer persona) within the same project. Users must manually copy messages between channels to orchestrate multi-agent workflows.

## Goals

- Enable agent-to-agent communication across Discord channels within a single project
- Support per-channel personas with configurable system prompts
- Prevent infinite loops between agents
- Keep changes minimal and surgical — no architecture rewrites

## Non-Goals

- Cross-project (different `directory`) communication
- Multiple directive types beyond `POST_TO`
- Persistence of thread links across restarts
- Structured payloads, return values, or file passing between agents
- Slack or any non-Discord transport

## Approach

Directive Parser + Thread Link Registry (Approach A). Four new focused modules plus surgical edits to existing code. Each concern is isolated: parsing, routing, loop prevention, persona injection.

---

## 1. Config Changes

The `projects` record in `config.json` gains an optional `persona` field per channel:

```json
{
  "projects": {
    "123456": {
      "name": "pm",
      "directory": "/home/user/myproject",
      "persona": {
        "systemPrompt": "You are a product manager. When you need engineering work done, delegate using the ---mpg-directive block format.",
        "canMessageChannels": ["#engineer"],
        "maxDirectivesPerTurn": 1
      }
    },
    "789012": {
      "name": "engineer",
      "directory": "/home/user/myproject",
      "persona": {
        "systemPrompt": "You are a senior engineer. Focus on implementation. When done, report back to the requesting channel.",
        "canMessageChannels": ["#pm"]
      }
    }
  }
}
```

- `systemPrompt` — prepended to every user message sent to Claude for this channel.
- `canMessageChannels` — whitelist of channel names this agent can post to. Enforced by the gateway, not by Claude.
- `maxDirectivesPerTurn` — optional, defaults to 1. Cap per response to limit fan-out.

A new `maxTurnsPerLink` field is added to `defaults` (default: 5). This controls the loop prevention limit per thread pair.

Both channels in a multi-agent setup map to the same `directory`. No new top-level config keys.

## 2. Persona Injection

When `sessionManager.send()` is called for a channel that has a `persona.systemPrompt`, the gateway prepends it to the user message before passing to `claude --print`:

```
[SYSTEM]
You are a product manager. When you need engineering work done, delegate using the ---mpg-directive block format.

To delegate to another channel, end your response with:
---mpg-directive
POST_TO: #channel-name
your message here
---

[USER MESSAGE]
Hey, can you review the Drive integration requirements?
```

This happens inside `session-manager.ts`'s `processQueue` method — a simple string concatenation before calling `runClaude`. The directive format instructions are appended automatically whenever `canMessageChannels` is non-empty, so Claude knows the syntax without the operator having to include it in every system prompt.

No changes to `claude-cli.ts`.

## 3. Directive Parser

A new module `src/directive-parser.ts`.

**Input:** raw Claude response string.
**Output:** `{ cleanText: string, directive: Directive | null }`

```typescript
interface Directive {
  action: 'POST_TO';
  targetChannel: string;  // e.g. "engineer" (resolved from "#engineer")
  content: string;        // the message body, can be multi-line
}
```

**Parsing rules:**

- Look for `---mpg-directive\n` followed by content and terminated by `---` at end of string (after trimming trailing whitespace).
- If no block found, return the full text as `cleanText` with `null` directive.
- Extract the first line after the delimiter as the action line (`POST_TO: #channel-name`).
- Everything between the action line and closing `---` is the message content.
- Strip the `#` prefix from channel name — it's cosmetic for Claude's benefit, the gateway resolves by project name.
- If the block is malformed (missing action, unknown action type), ignore it — return full text with no directive. Fail silently for the prototype.
- Not in scope: multiple directives per response, nested directives, any action other than `POST_TO`.

## 4. Agent Message Tracker

A new module `src/agent-tracker.ts`. A thin wrapper around a `Set<string>` that tracks which Discord message IDs are Claude agent responses vs. gateway status messages.

```typescript
interface AgentTracker {
  track(messageId: string): void;
  isAgentMessage(messageId: string): boolean;  // returns true and deletes (one-time use)
}
```

**Usage:**

- When the gateway sends Claude's response chunks to a thread, each sent message ID is registered via `track()`.
- Gateway status messages (errors, session warnings, attribution headers for cross-posts) are **not** tracked.
- In the message handler, when `message.author.bot` is true: check `isAgentMessage(message.id)`. If false, check cross-post set. If neither, return early.
- Entries are deleted on read (one-time use). The set stays small.

## 5. Thread Link Registry

A new module `src/thread-links.ts`. Manages the mapping between cross-channel conversation threads and enforces loop prevention.

```typescript
interface ThreadLink {
  sourceThread: string;   // thread ID where directive originated
  targetThread: string;   // thread ID created/found in target channel
  sourceChannel: string;  // parent channel name (for attribution)
  turnCount: number;      // incremented each time a directive fires between this pair
}

interface ThreadLinkRegistry {
  link(sourceThread: string, targetThread: string, sourceChannel: string): ThreadLink;
  getLinkedThread(threadId: string): ThreadLink | null;
  recordTurn(sourceThread: string, targetThread: string): number;
  isOverLimit(sourceThread: string, targetThread: string, max: number): boolean;
  resetPair(sourceThread: string, targetThread: string): void;
}
```

**Behavior:**

- When a directive is parsed from an agent response in thread A, the registry looks up whether thread A already has a linked thread in the target channel. If yes, post there. If no, create a new thread in the target channel and register the link.
- `recordTurn()` increments the counter each time a directive fires between a pair. When `isOverLimit()` returns true, the gateway posts a warning in the source thread and does not route the directive.
- `resetPair()` is called when a human (non-bot) message appears in either thread of a linked pair. This is the "implicit keep going" mechanism.
- Links are bidirectional — the pair is unordered. If thread A links to thread B, and B's agent responds back to A's channel, the same link record is used.
- In-memory only. No persistence across restarts for the prototype.
- Default max turns per pair: 5, configurable via `defaults.maxTurnsPerLink`.

## 6. Changes to `discord.ts` — Message Handler

The core message handler gets a second code path for bot messages.

**New flow:**

1. `if (message.author.bot)`:
   - Check `crossPostIds` — if match, route to session like a human message (this is a delegated message arriving in the target channel).
   - Check `agentTracker.isAgentMessage(message.id)` — if match, pass content to directive parser.
     - If directive found: validate `canMessageChannels`, check loop limit, cross-post to target.
     - If no directive: return (agent response with no delegation).
   - Otherwise: return (gateway status message, ignore).
2. Human message path (unchanged, plus): if this message is in a thread that belongs to a linked pair, call `registry.resetPair()` to reset the turn counter.

**Cross-posting flow when a directive is found:**

1. Resolve `targetChannel` name to a channel ID via config (reverse lookup by project name).
2. Check `canMessageChannels` — if target not in whitelist, post a warning in the source thread and stop.
3. Check `registry.isOverLimit()` — if over, post warning ("Loop limit reached — a human message in either thread will reset") and stop.
4. Look up existing linked thread via `registry.getLinkedThread()`. If none, create a new thread in the target channel with name `"From #source: {first 80 chars}"`.
5. Register the link and record the turn.
6. Post to target thread with attribution header: `**From #source-channel:**\n{content}`.
7. Track the sent message ID in `crossPostIds` (not `agentTracker`). The target channel's session processes it like a human message.

**Three message categories for bot messages:**

| Category | Tracked in | Action |
|----------|-----------|--------|
| Agent response | `agentTracker` | Parse for directives |
| Cross-post | `crossPostIds` | Route to target session |
| Status message | neither | Ignore |

## 7. File Change Summary

### New files

| File | Responsibility |
|------|---------------|
| `src/directive-parser.ts` | Parse `---mpg-directive` blocks, return clean text + directive |
| `src/thread-links.ts` | Thread link registry with turn counting and loop prevention |
| `src/agent-tracker.ts` | Track agent message IDs and cross-post message IDs |

### Changed files

| File | Change |
|------|--------|
| `src/config.ts` | Add optional `persona` to `ProjectConfig`, add `maxTurnsPerLink` to `GatewayDefaults` |
| `src/session-manager.ts` | Accept persona config, prepend system prompt + directive format instructions when persona is present |
| `src/discord.ts` | Three-way bot message handling, human message resets linked pair counters, cross-post flow with attribution and thread creation |

### Unchanged files

`router.ts`, `claude-cli.ts`, `worktree.ts`, `session-store.ts`, `cli.ts`

### New tests

| File | Coverage |
|------|----------|
| `tests/directive-parser.test.ts` | Parsing, edge cases, malformed blocks |
| `tests/thread-links.test.ts` | Link creation, turn counting, reset on human message, over-limit |
| `tests/agent-tracker.test.ts` | Track, check, one-time delete |
| Updated `tests/discord.test.ts` | Bot message routing paths |

## 8. Implementation Notes

- **Persona config passing:** Persona config is passed to `createSessionManager` at construction time (alongside existing `defaults`). The session manager looks up the persona for a given `projectKey` and prepends the system prompt internally. This avoids changing the `send()` signature.
- **Channel name reverse lookup:** A helper function (e.g. `findChannelByName` in `config.ts` or `router.ts`) is needed to resolve a project name like "engineer" to its channel ID. The existing `findProjectByName` in `discord.ts` does this already — extract and reuse it.
- **Message ID tracking ordering:** `track()` is called synchronously on the `Message` object returned by `channel.send()`. The `MessageCreate` event for the bot's own message fires asynchronously after the API response, so `track()` will always execute first. No race condition in practice.
