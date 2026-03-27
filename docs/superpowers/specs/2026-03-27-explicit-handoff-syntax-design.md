# Explicit Handoff Syntax

**Goal:** Prevent false and accidental agent handoffs by requiring an explicit `HANDOFF @agent: <task>` syntax for dispatch, while allowing conversational references to other agents without triggering handoffs.

**Closes:** #71

## Problem

`parseAgentMention` matches any `@agent` pattern in agent responses. This causes:
1. **Accidental dispatch:** "Once approved, I'll hand off to @engineer" triggers immediate handoff
2. **False dispatch:** Agent says "Sent to PM" without writing `@pm`, so nothing happens

## Design

### New: `parseHandoffCommand`

New function in `agent-dispatch.ts` that only matches the explicit syntax:

```
HANDOFF @engineer: implement the login feature based on the spec above
```

- Pattern: `/^HANDOFF\s+@(\w+)\s*:\s*/im` (case-insensitive, multiline so it can appear on any line)
- Returns `{ agentName, agent, prompt }` where prompt is everything after the colon on that line
- Returns `null` if no match
- Bare `@agent` mentions are ignored

### Changed: Handoff loop in `discord.ts`

- The auto-handoff loop (lines ~369-430) switches from `parseAgentMention` to `parseHandoffCommand` for detecting dispatch in **agent responses**
- User-initiated routing (line ~311) continues using `parseAgentMention` — users still type `@engineer do this`

### Changed: Persona prompts in `persona-presets.ts`

**PM prompt updates:**
- Replace `@engineer` dispatch instructions with `HANDOFF @engineer: <task>` syntax
- Add: "To reference another agent without dispatching, say 'the engineer' — do NOT write @agent outside of a HANDOFF command"
- Add: "Only use HANDOFF when you are ready to dispatch work NOW, not when describing future plans"

**Engineer prompt updates:**
- Replace `@pm` reporting instructions with `HANDOFF @pm: <update>` syntax
- Same conversational reference guidance

**All other presets (qa, designer, devops):**
- Add the conversational reference guidance so they don't accidentally trigger handoffs if used

### Unchanged

- `parseAgentMention` function stays as-is (used for user messages)
- User-facing `@agent` routing in discord.ts (line ~311)
- Turn counter, session management, handoff announcements

## Testing

- `parseHandoffCommand`: match on valid syntax, no match on bare `@agent`, no match on conversational references, case insensitivity
- Handoff loop: verify `HANDOFF @engineer:` triggers dispatch, verify bare `@engineer` does NOT
- Backward compatibility: user `@agent` mentions still route correctly
