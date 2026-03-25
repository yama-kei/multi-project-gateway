# Persona-Labeled Embeds with Color-Coded Sidebars

**Issue:** #45
**Date:** 2026-03-25
**Status:** Approved

## Summary

Add visual differentiation for multi-agent persona messages in Discord threads using color-coded embeds with persona labels. Zero-config defaults, no breaking changes. Thread digests (stretch goal) deferred to a separate issue.

## Approach

Discord `EmbedBuilder` replaces plain `.send(text)` when an agent persona is active. Non-agent messages remain plain text.

## Embed Format

Each agent response is wrapped in a Discord embed:

- **Author**: `agent.role` (e.g., "Product Manager", "Engineer")
- **Color**: Deterministic sidebar color derived from agent key hash
- **Description**: Message content with Discord markdown preserved
- **No footer/thumbnail/image** — minimal, clean layout

Non-agent messages (default session, no personas configured) remain plain text unchanged.

## Color Assignment

A curated palette of 10 high-contrast colors suitable for both light and dark Discord themes:

| Hex       | Name   |
|-----------|--------|
| `#3498DB` | Blue   |
| `#E74C3C` | Red    |
| `#2ECC71` | Green  |
| `#9B59B6` | Purple |
| `#F39C12` | Orange |
| `#1ABC9C` | Teal   |
| `#E91E63` | Pink   |
| `#FF9800` | Amber  |
| `#00BCD4` | Cyan   |
| `#8BC34A` | Lime   |

**Hash function**: Simple string hash (djb2 variant) of the agent key modulo palette length. Deterministic — same key always maps to the same color regardless of project or config order.

```typescript
function agentColor(agentKey: string): number {
  let hash = 0;
  for (const ch of agentKey) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
```

No config field needed.

## Chunking & Message Sending

Current behavior: `chunkMessage(text, 2000)` splits at Discord's plain-text limit.

New behavior with a `sendAgentMessage(channel, text, agentName, agentRole)` helper:

- **Agent present**: Chunk at 4096 (embed description limit). Each chunk wrapped in `EmbedBuilder` with author and color. First chunk uses role as author; continuation chunks use `"${role} (cont.)"`.
- **No agent**: Chunk at 2000, send as plain text (existing behavior preserved).
- **Error/system messages**: Remain plain text regardless of agent context.

### Send sites in `discord.ts` to update

1. **Lines 310-313**: Initial agent response — use `sendAgentMessage`
2. **Lines 370-373**: Handoff loop response — use `sendAgentMessage`
3. **Lines 361-363**: Agent failure message — stays plain text (system message)

## New Module: `src/embed-format.ts`

Extracted pure functions:

- `agentColor(agentKey: string): number` — deterministic color from palette
- `buildAgentEmbeds(text: string, agentName: string, agentRole: string): EmbedBuilder[]` — chunk and wrap in embeds
- `sendAgentMessage(channel, text, agentName?, agentRole?)` — send as embed or plain text

## Testing

**New file: `tests/embed-format.test.ts`**
- Color determinism: same key always returns same color
- Different keys produce different colors (probabilistic)
- Embed structure: author name, color value, description content
- Chunking at 4096 with continuation author labels
- Null agent returns null (plain text path)

**Existing: `tests/discord.test.ts`**
- `chunkMessage` regression tests at 2000 limit unchanged

No integration/E2E changes needed — `EmbedBuilder` is a pure data structure.

## Scope Boundaries

- **In scope**: Persona-labeled embeds, color-coded sidebars, zero-config defaults
- **Out of scope**: Thread digests, custom color config, avatar/thumbnail per persona
- **No breaking changes**: Projects without agents see zero behavioral change
