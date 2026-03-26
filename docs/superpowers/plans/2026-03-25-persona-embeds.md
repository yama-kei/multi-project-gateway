# Persona-Labeled Embeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap agent persona messages in Discord embeds with color-coded sidebars and role labels, while leaving non-agent messages as plain text.

**Architecture:** New `src/embed-format.ts` module with pure functions for color hashing, embed building, and message sending. `src/discord.ts` delegates to this module at the two agent-response send sites. No config changes.

**Tech Stack:** discord.js `EmbedBuilder`, vitest, TypeScript

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/embed-format.ts` | `agentColor()`, `buildAgentEmbeds()`, `sendAgentMessage()` |
| Create | `tests/embed-format.test.ts` | Unit tests for all embed-format functions |
| Modify | `src/discord.ts:1` | Add import for `sendAgentMessage` |
| Modify | `src/discord.ts:310-313` | Replace plain send with `sendAgentMessage` |
| Modify | `src/discord.ts:370-373` | Replace handoff plain send with `sendAgentMessage` |

---

### Task 1: agentColor — failing tests

**Files:**
- Create: `tests/embed-format.test.ts`

- [ ] **Step 1: Write the failing tests for agentColor**

```typescript
import { describe, it, expect } from 'vitest';
import { agentColor, PALETTE } from '../src/embed-format.js';

describe('agentColor', () => {
  it('returns the same color for the same key', () => {
    expect(agentColor('pm')).toBe(agentColor('pm'));
  });

  it('returns a value from the palette', () => {
    const color = agentColor('pm');
    expect(PALETTE).toContain(color);
  });

  it('returns different colors for different keys', () => {
    const colors = new Set(['pm', 'engineer', 'designer', 'qa', 'devops'].map(agentColor));
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it('is case-sensitive (keys are pre-lowered by config)', () => {
    // Agent keys are always lowercased by loadConfig, so this just documents behavior
    const a = agentColor('pm');
    const b = agentColor('PM');
    // They may or may not match — the contract is: pass lowercased keys
    expect(typeof a).toBe('number');
    expect(typeof b).toBe('number');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: FAIL — cannot find module `../src/embed-format.js`

---

### Task 2: agentColor — implementation

**Files:**
- Create: `src/embed-format.ts`

- [ ] **Step 1: Implement agentColor and PALETTE**

```typescript
// src/embed-format.ts
import { EmbedBuilder, type TextChannel, type ThreadChannel } from 'discord.js';
import { chunkMessage } from './discord.js';

/** 10 high-contrast colors for light and dark Discord themes. */
export const PALETTE: readonly number[] = [
  0x3498db, // blue
  0xe74c3c, // red
  0x2ecc71, // green
  0x9b59b6, // purple
  0xf39c12, // orange
  0x1abc9c, // teal
  0xe91e63, // pink
  0xff9800, // amber
  0x00bcd4, // cyan
  0x8bc34a, // lime
];

/** Deterministic color for an agent key (djb2 hash mod palette length). */
export function agentColor(agentKey: string): number {
  let hash = 0;
  for (const ch of agentKey) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: PASS — all 4 agentColor tests green

- [ ] **Step 3: Commit**

```bash
git add src/embed-format.ts tests/embed-format.test.ts
git commit -m "feat(embed): add agentColor with deterministic palette hashing (#45)"
```

---

### Task 3: buildAgentEmbeds — failing tests

**Files:**
- Modify: `tests/embed-format.test.ts`

- [ ] **Step 1: Write the failing tests for buildAgentEmbeds**

Append to `tests/embed-format.test.ts`:

Add these imports to the existing import block at the top of the file:

```typescript
import { buildAgentEmbeds } from '../src/embed-format.js';
```

Then append this describe block:

```typescript
describe('buildAgentEmbeds', () => {
  it('returns a single embed for short text', () => {
    const embeds = buildAgentEmbeds('Hello world', 'pm', 'Product Manager');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.description).toBe('Hello world');
    expect(embeds[0].data.author?.name).toBe('Product Manager');
    expect(embeds[0].data.color).toBe(agentColor('pm'));
  });

  it('chunks long text at 4096 characters', () => {
    const text = 'A'.repeat(5000);
    const embeds = buildAgentEmbeds(text, 'engineer', 'Engineer');
    expect(embeds).toHaveLength(2);
    expect(embeds[0].data.description).toHaveLength(4096);
    expect(embeds[0].data.author?.name).toBe('Engineer');
    expect(embeds[1].data.description).toHaveLength(904);
    expect(embeds[1].data.author?.name).toBe('Engineer (cont.)');
  });

  it('preserves color across all chunks', () => {
    const text = 'A'.repeat(9000);
    const embeds = buildAgentEmbeds(text, 'pm', 'Product Manager');
    const expectedColor = agentColor('pm');
    for (const embed of embeds) {
      expect(embed.data.color).toBe(expectedColor);
    }
  });

  it('handles empty text', () => {
    const embeds = buildAgentEmbeds('', 'pm', 'Product Manager');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].data.description).toBe('');
    expect(embeds[0].data.author?.name).toBe('Product Manager');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: FAIL — `buildAgentEmbeds` is not exported from `../src/embed-format.js`

---

### Task 4: buildAgentEmbeds — implementation

**Files:**
- Modify: `src/embed-format.ts`

- [ ] **Step 1: Add buildAgentEmbeds to embed-format.ts**

Append after `agentColor`:

```typescript
const EMBED_DESCRIPTION_LIMIT = 4096;

/** Build Discord embeds for an agent response, chunking at 4096 chars. */
export function buildAgentEmbeds(text: string, agentName: string, agentRole: string): EmbedBuilder[] {
  const color = agentColor(agentName);
  const chunks = chunkMessage(text, EMBED_DESCRIPTION_LIMIT);

  return chunks.map((chunk, i) => {
    const authorName = i === 0 ? agentRole : `${agentRole} (cont.)`;
    return new EmbedBuilder()
      .setAuthor({ name: authorName })
      .setColor(color)
      .setDescription(chunk);
  });
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: PASS — all agentColor + buildAgentEmbeds tests green

- [ ] **Step 3: Commit**

```bash
git add src/embed-format.ts tests/embed-format.test.ts
git commit -m "feat(embed): add buildAgentEmbeds with chunked embed construction (#45)"
```

---

### Task 5: sendAgentMessage — failing tests

**Files:**
- Modify: `tests/embed-format.test.ts`

- [ ] **Step 1: Write the failing tests for sendAgentMessage**

Append to `tests/embed-format.test.ts`:

Add these imports to the existing import block at the top of the file:

```typescript
import { sendAgentMessage } from '../src/embed-format.js';
```

Also add `vi` to the existing vitest import: `import { describe, it, expect, vi } from 'vitest';`

Then append this helper and describe block:

```typescript
function mockChannel() {
  const sent: unknown[] = [];
  return {
    send: vi.fn(async (content: unknown) => { sent.push(content); }),
    sent,
  };
}

describe('sendAgentMessage', () => {
  it('sends plain text when no agent is provided', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'Hello world');
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]).toBe('Hello world');
  });

  it('sends embeds when agent is provided', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'Hello world', 'pm', 'Product Manager');
    expect(ch.sent).toHaveLength(1);
    const msg = ch.sent[0] as { embeds: EmbedBuilder[] };
    expect(msg.embeds).toHaveLength(1);
    expect(msg.embeds[0].data.author?.name).toBe('Product Manager');
  });

  it('sends multiple messages for long plain text (2000 limit)', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'A'.repeat(4500));
    expect(ch.sent).toHaveLength(3); // 2000 + 2000 + 500
    expect(typeof ch.sent[0]).toBe('string');
  });

  it('sends multiple embed messages for long agent text (4096 limit)', async () => {
    const ch = mockChannel();
    await sendAgentMessage(ch as any, 'A'.repeat(5000), 'pm', 'Product Manager');
    expect(ch.sent).toHaveLength(2); // 4096 + 904
    const msg1 = ch.sent[0] as { embeds: EmbedBuilder[] };
    const msg2 = ch.sent[1] as { embeds: EmbedBuilder[] };
    expect(msg1.embeds[0].data.author?.name).toBe('Product Manager');
    expect(msg2.embeds[0].data.author?.name).toBe('Product Manager (cont.)');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: FAIL — `sendAgentMessage` is not exported from `../src/embed-format.js`

---

### Task 6: sendAgentMessage — implementation

**Files:**
- Modify: `src/embed-format.ts`

- [ ] **Step 1: Add sendAgentMessage to embed-format.ts**

Append after `buildAgentEmbeds`:

```typescript
const PLAIN_TEXT_LIMIT = 2000;

/** Send a message as embeds (if agent) or plain text (if not). */
export async function sendAgentMessage(
  channel: { send(content: unknown): Promise<unknown> },
  text: string,
  agentName?: string,
  agentRole?: string,
): Promise<void> {
  if (agentName && agentRole) {
    const embeds = buildAgentEmbeds(text, agentName, agentRole);
    for (const embed of embeds) {
      await channel.send({ embeds: [embed] });
    }
  } else {
    const chunks = chunkMessage(text, PLAIN_TEXT_LIMIT);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/embed-format.test.ts`
Expected: PASS — all tests green

- [ ] **Step 3: Commit**

```bash
git add src/embed-format.ts tests/embed-format.test.ts
git commit -m "feat(embed): add sendAgentMessage helper for embed/plain dispatch (#45)"
```

---

### Task 7: Integrate into discord.ts — initial response

**Files:**
- Modify: `src/discord.ts:1` (add import)
- Modify: `src/discord.ts:310-313` (replace plain send)

- [ ] **Step 1: Add import at top of discord.ts**

After line 5 (`import { parseAgentMention } from './agent-dispatch.js';`), add:

```typescript
import { sendAgentMessage } from './embed-format.js';
```

- [ ] **Step 2: Replace the initial response send (lines 310-313)**

Replace:
```typescript
      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        await replyChannel.send(chunk);
      }
```

With:
```typescript
      await sendAgentMessage(
        replyChannel,
        result.text,
        activeAgent?.agentName,
        activeAgent?.agent.role,
      );
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests still pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add src/discord.ts
git commit -m "feat(embed): use sendAgentMessage for initial agent response (#45)"
```

---

### Task 8: Integrate into discord.ts — handoff response

**Files:**
- Modify: `src/discord.ts:370-373` (replace handoff plain send)

- [ ] **Step 1: Replace the handoff response send (lines 370-373)**

Replace:
```typescript
          const handoffChunks = chunkMessage(handoffResult.text, 2000);
          for (const chunk of handoffChunks) {
            await replyChannel.send(chunk);
          }
```

With:
```typescript
          await sendAgentMessage(
            replyChannel,
            handoffResult.text,
            handoff.agentName,
            handoff.agent.role,
          );
```

- [ ] **Step 2: Remove unused chunkMessage import if no longer needed in discord.ts**

Check if `chunkMessage` is still used directly in `discord.ts`. It is exported and used in `embed-format.ts`, so keep the export. But check if discord.ts itself still calls `chunkMessage` directly anywhere. After the two replacements, it should not — but it's still exported from `discord.ts` for the test file and for `embed-format.ts` to import. Leave the function in place; remove nothing.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests green

- [ ] **Step 4: Commit**

```bash
git add src/discord.ts
git commit -m "feat(embed): use sendAgentMessage for handoff responses (#45)"
```

---

### Task 9: Verify existing tests, run build

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests green including existing discord.test.ts chunkMessage tests

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Final commit if any cleanup needed**

If the build or tests surfaced any issues, fix and commit. Otherwise, no action needed.
