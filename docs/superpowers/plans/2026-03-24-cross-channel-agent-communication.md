# Cross-Channel Agent Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agent-to-agent communication across Discord channels within a single project, with persona injection, directive parsing, thread linking, and loop prevention.

**Architecture:** New modules (directive-parser, thread-links, agent-tracker) slot alongside existing router and session-manager. The Discord message handler gains a three-way bot message routing path. Persona system prompts are prepended by the session manager at construction time. The directive parser extracts `---mpg-directive` blocks from Claude responses, and the thread link registry manages cross-channel thread pairs with turn-based loop prevention.

**Tech Stack:** TypeScript, discord.js, Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-cross-channel-agent-communication-design.md`

---

### Task 1: Directive Parser

**Files:**
- Create: `src/directive-parser.ts`
- Test: `tests/directive-parser.test.ts`

- [ ] **Step 1: Write failing tests for directive parser**

Create `tests/directive-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseDirective } from '../src/directive-parser.js';

describe('parseDirective', () => {
  it('returns null directive when no block is present', () => {
    const result = parseDirective('Just a normal response with no directives.');
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe('Just a normal response with no directives.');
  });

  it('extracts a POST_TO directive from the end of the response', () => {
    const input = [
      'Here is my analysis.',
      '',
      '---mpg-directive',
      'POST_TO: #engineer',
      'Please implement the login flow as described above.',
      '---',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.cleanText).toBe('Here is my analysis.');
    expect(result.directive).toEqual({
      action: 'POST_TO',
      targetChannel: 'engineer',
      content: 'Please implement the login flow as described above.',
    });
  });

  it('handles multi-line directive content', () => {
    const input = [
      'Done thinking.',
      '',
      '---mpg-directive',
      'POST_TO: #engineer',
      'Line one of the message.',
      'Line two of the message.',
      '',
      'Line four after a blank.',
      '---',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.cleanText).toBe('Done thinking.');
    expect(result.directive).not.toBeNull();
    expect(result.directive!.content).toBe(
      'Line one of the message.\nLine two of the message.\n\nLine four after a blank.'
    );
  });

  it('strips # prefix from channel name', () => {
    const input = '---mpg-directive\nPOST_TO: #my-channel\nhello\n---';
    const result = parseDirective(input);
    expect(result.directive!.targetChannel).toBe('my-channel');
  });

  it('handles channel name without # prefix', () => {
    const input = '---mpg-directive\nPOST_TO: engineer\nhello\n---';
    const result = parseDirective(input);
    expect(result.directive!.targetChannel).toBe('engineer');
  });

  it('ignores trailing whitespace after closing delimiter', () => {
    const input = 'Response.\n\n---mpg-directive\nPOST_TO: #eng\ndo it\n---\n  \n';
    const result = parseDirective(input);
    expect(result.directive).not.toBeNull();
    expect(result.directive!.targetChannel).toBe('eng');
  });

  it('returns null directive for malformed block (missing action line)', () => {
    const input = 'Response.\n\n---mpg-directive\n\n---';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for unknown action type', () => {
    const input = 'Response.\n\n---mpg-directive\nSEND_FILE: #eng\nfoo\n---';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for block not at the end', () => {
    const input = [
      '---mpg-directive',
      'POST_TO: #engineer',
      'hello',
      '---',
      '',
      'More text after the block.',
    ].join('\n');
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns null directive for missing closing delimiter', () => {
    const input = 'Response.\n\n---mpg-directive\nPOST_TO: #eng\ndo it';
    const result = parseDirective(input);
    expect(result.directive).toBeNull();
    expect(result.cleanText).toBe(input);
  });

  it('returns empty cleanText when entire response is a directive', () => {
    const input = '---mpg-directive\nPOST_TO: #eng\nhello world\n---';
    const result = parseDirective(input);
    expect(result.cleanText).toBe('');
    expect(result.directive).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/directive-parser.test.ts`
Expected: FAIL — `parseDirective` does not exist yet.

- [ ] **Step 3: Implement the directive parser**

Create `src/directive-parser.ts`:

```typescript
export interface Directive {
  action: 'POST_TO';
  targetChannel: string;
  content: string;
}

export interface ParseResult {
  cleanText: string;
  directive: Directive | null;
}

const OPEN_DELIM = '---mpg-directive\n';
const CLOSE_DELIM = '\n---';

export function parseDirective(text: string): ParseResult {
  const trimmed = text.trimEnd();

  if (!trimmed.endsWith('---')) {
    return { cleanText: text, directive: null };
  }

  // Find the last occurrence of the opening delimiter
  const openIdx = trimmed.lastIndexOf(OPEN_DELIM);
  if (openIdx === -1) {
    return { cleanText: text, directive: null };
  }

  const blockBody = trimmed.slice(openIdx + OPEN_DELIM.length);

  // The block must end with --- and that must be the closing delimiter
  const closeIdx = blockBody.lastIndexOf(CLOSE_DELIM);
  if (closeIdx === -1) {
    // Check if the closing --- is right at the end without a preceding newline
    if (!blockBody.endsWith('---')) {
      return { cleanText: text, directive: null };
    }
    return { cleanText: text, directive: null };
  }

  // Ensure the closing --- is at the very end of the block
  const afterClose = blockBody.slice(closeIdx + CLOSE_DELIM.length);
  if (afterClose.length > 0) {
    return { cleanText: text, directive: null };
  }

  const innerContent = blockBody.slice(0, closeIdx);
  const lines = innerContent.split('\n');
  const actionLine = lines[0]?.trim();

  if (!actionLine) {
    return { cleanText: text, directive: null };
  }

  const postToMatch = actionLine.match(/^POST_TO:\s*#?(.+)$/);
  if (!postToMatch) {
    return { cleanText: text, directive: null };
  }

  const targetChannel = postToMatch[1].trim();
  const content = lines.slice(1).join('\n').trim();

  const cleanText = text.slice(0, openIdx).trimEnd();

  return {
    cleanText,
    directive: {
      action: 'POST_TO',
      targetChannel,
      content,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/directive-parser.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/directive-parser.ts tests/directive-parser.test.ts
git commit -m "feat: add directive parser for ---mpg-directive blocks"
```

---

### Task 2: Agent Message Tracker

**Files:**
- Create: `src/agent-tracker.ts`
- Test: `tests/agent-tracker.test.ts`

- [ ] **Step 1: Write failing tests for agent tracker**

Create `tests/agent-tracker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createAgentTracker } from '../src/agent-tracker.js';

describe('createAgentTracker', () => {
  it('returns false for untracked message IDs', () => {
    const tracker = createAgentTracker();
    expect(tracker.isAgentMessage('unknown-id')).toBe(false);
  });

  it('returns true for tracked message IDs', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
  });

  it('deletes entry after isAgentMessage returns true (one-time use)', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isAgentMessage('msg-1')).toBe(false);
  });

  it('tracks multiple messages independently', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    tracker.track('msg-2');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isAgentMessage('msg-2')).toBe(true);
    expect(tracker.isAgentMessage('msg-1')).toBe(false);
    expect(tracker.isAgentMessage('msg-2')).toBe(false);
  });

  it('returns false for untracked cross-post IDs', () => {
    const tracker = createAgentTracker();
    expect(tracker.isCrossPost('unknown-id')).toBe(false);
  });

  it('returns true for tracked cross-post IDs and deletes (one-time use)', () => {
    const tracker = createAgentTracker();
    tracker.trackCrossPost('msg-1');
    expect(tracker.isCrossPost('msg-1')).toBe(true);
    expect(tracker.isCrossPost('msg-1')).toBe(false);
  });

  it('agent messages and cross-posts are independent sets', () => {
    const tracker = createAgentTracker();
    tracker.track('msg-1');
    tracker.trackCrossPost('msg-2');
    expect(tracker.isAgentMessage('msg-1')).toBe(true);
    expect(tracker.isCrossPost('msg-1')).toBe(false);
    expect(tracker.isCrossPost('msg-2')).toBe(true);
    expect(tracker.isAgentMessage('msg-2')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-tracker.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the agent tracker**

Create `src/agent-tracker.ts`:

```typescript
export interface AgentTracker {
  track(messageId: string): void;
  isAgentMessage(messageId: string): boolean;
  trackCrossPost(messageId: string): void;
  isCrossPost(messageId: string): boolean;
}

export function createAgentTracker(): AgentTracker {
  const agentMessages = new Set<string>();
  const crossPosts = new Set<string>();

  return {
    track(messageId: string): void {
      agentMessages.add(messageId);
    },

    isAgentMessage(messageId: string): boolean {
      const found = agentMessages.has(messageId);
      if (found) agentMessages.delete(messageId);
      return found;
    },

    trackCrossPost(messageId: string): void {
      crossPosts.add(messageId);
    },

    isCrossPost(messageId: string): boolean {
      const found = crossPosts.has(messageId);
      if (found) crossPosts.delete(messageId);
      return found;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent-tracker.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-tracker.ts tests/agent-tracker.test.ts
git commit -m "feat: add agent message tracker for bot message routing"
```

---

### Task 3: Thread Link Registry

**Files:**
- Create: `src/thread-links.ts`
- Test: `tests/thread-links.test.ts`

- [ ] **Step 1: Write failing tests for thread link registry**

Create `tests/thread-links.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createThreadLinkRegistry } from '../src/thread-links.js';

describe('createThreadLinkRegistry', () => {
  it('returns null for unlinked threads', () => {
    const registry = createThreadLinkRegistry();
    expect(registry.getLinkedThread('thread-a')).toBeNull();
  });

  it('creates a link between two threads', () => {
    const registry = createThreadLinkRegistry();
    const link = registry.link('thread-a', 'thread-b', 'pm');
    expect(link.sourceThread).toBe('thread-a');
    expect(link.targetThread).toBe('thread-b');
    expect(link.sourceChannel).toBe('pm');
    expect(link.turnCount).toBe(0);
  });

  it('retrieves linked thread from source side', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    const link = registry.getLinkedThread('thread-a');
    expect(link).not.toBeNull();
    expect(link!.targetThread).toBe('thread-b');
  });

  it('retrieves linked thread from target side (bidirectional)', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    const link = registry.getLinkedThread('thread-b');
    expect(link).not.toBeNull();
    expect(link!.sourceThread).toBe('thread-a');
  });

  it('records turns and increments counter', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(2);
    expect(registry.recordTurn('thread-b', 'thread-a')).toBe(3);
  });

  it('checks over-limit correctly', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(false);
    registry.recordTurn('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(true);
  });

  it('resets pair turn counter', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    registry.resetPair('thread-a', 'thread-b');
    expect(registry.isOverLimit('thread-a', 'thread-b', 3)).toBe(false);
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
  });

  it('resetPair works from either side of the pair', () => {
    const registry = createThreadLinkRegistry();
    registry.link('thread-a', 'thread-b', 'pm');
    registry.recordTurn('thread-a', 'thread-b');
    registry.recordTurn('thread-a', 'thread-b');
    registry.resetPair('thread-b', 'thread-a');
    expect(registry.recordTurn('thread-a', 'thread-b')).toBe(1);
  });

  it('isOverLimit returns false for unlinked threads', () => {
    const registry = createThreadLinkRegistry();
    expect(registry.isOverLimit('x', 'y', 5)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/thread-links.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the thread link registry**

Create `src/thread-links.ts`:

```typescript
export interface ThreadLink {
  sourceThread: string;
  targetThread: string;
  sourceChannel: string;
  turnCount: number;
}

export interface ThreadLinkRegistry {
  link(sourceThread: string, targetThread: string, sourceChannel: string): ThreadLink;
  getLinkedThread(threadId: string): ThreadLink | null;
  recordTurn(sourceThread: string, targetThread: string): number;
  isOverLimit(sourceThread: string, targetThread: string, max: number): boolean;
  resetPair(sourceThread: string, targetThread: string): void;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function createThreadLinkRegistry(): ThreadLinkRegistry {
  const links = new Map<string, ThreadLink>();
  // Index: threadId -> pairKey, so we can look up a link from either side
  const threadIndex = new Map<string, string>();

  return {
    link(sourceThread: string, targetThread: string, sourceChannel: string): ThreadLink {
      const key = pairKey(sourceThread, targetThread);
      const existing = links.get(key);
      if (existing) return existing;

      const link: ThreadLink = { sourceThread, targetThread, sourceChannel, turnCount: 0 };
      links.set(key, link);
      threadIndex.set(sourceThread, key);
      threadIndex.set(targetThread, key);
      return link;
    },

    getLinkedThread(threadId: string): ThreadLink | null {
      const key = threadIndex.get(threadId);
      if (!key) return null;
      return links.get(key) ?? null;
    },

    recordTurn(sourceThread: string, targetThread: string): number {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (!link) return 0;
      link.turnCount++;
      return link.turnCount;
    },

    isOverLimit(sourceThread: string, targetThread: string, max: number): boolean {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (!link) return false;
      return link.turnCount >= max;
    },

    resetPair(sourceThread: string, targetThread: string): void {
      const key = pairKey(sourceThread, targetThread);
      const link = links.get(key);
      if (link) link.turnCount = 0;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/thread-links.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/thread-links.ts tests/thread-links.test.ts
git commit -m "feat: add thread link registry with loop prevention"
```

---

### Task 4: Config Changes — Persona and maxTurnsPerLink

**Files:**
- Modify: `src/config.ts:1-63`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests for persona config**

Add to `tests/config.test.ts`:

```typescript
it('loads persona config when present', () => {
  const raw = {
    projects: {
      '123': {
        name: 'pm',
        directory: '/tmp/proj',
        persona: {
          systemPrompt: 'You are a PM.',
          canMessageChannels: ['#engineer'],
          maxDirectivesPerTurn: 2,
        },
      },
    },
  };
  const config = loadConfig(raw);
  expect(config.projects['123'].persona).toEqual({
    systemPrompt: 'You are a PM.',
    canMessageChannels: ['#engineer'],
    maxDirectivesPerTurn: 2,
  });
});

it('defaults maxDirectivesPerTurn to 1 when persona present but field omitted', () => {
  const raw = {
    projects: {
      '123': {
        name: 'pm',
        directory: '/tmp/proj',
        persona: {
          systemPrompt: 'You are a PM.',
          canMessageChannels: ['#engineer'],
        },
      },
    },
  };
  const config = loadConfig(raw);
  expect(config.projects['123'].persona!.maxDirectivesPerTurn).toBe(1);
});

it('leaves persona undefined when not provided', () => {
  const raw = {
    projects: {
      '123': { name: 'Test', directory: '/tmp/test' },
    },
  };
  const config = loadConfig(raw);
  expect(config.projects['123'].persona).toBeUndefined();
});

it('applies default maxTurnsPerLink', () => {
  const raw = {
    projects: { '123': { name: 'Test', directory: '/tmp/test' } },
  };
  const config = loadConfig(raw);
  expect(config.defaults.maxTurnsPerLink).toBe(5);
});

it('reads maxTurnsPerLink from defaults', () => {
  const raw = {
    defaults: { maxTurnsPerLink: 10 },
    projects: { '123': { name: 'Test', directory: '/tmp/test' } },
  };
  const config = loadConfig(raw);
  expect(config.defaults.maxTurnsPerLink).toBe(10);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `persona` not recognized, `maxTurnsPerLink` not on defaults.

- [ ] **Step 3: Update config types and loader**

Modify `src/config.ts`:

Add the `PersonaConfig` interface after `ProjectConfig`:

```typescript
export interface PersonaConfig {
  systemPrompt: string;
  canMessageChannels: string[];
  maxDirectivesPerTurn: number;
}
```

Add `persona?: PersonaConfig` to `ProjectConfig`:

```typescript
export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMs?: number;
  claudeArgs?: string[];
  persona?: PersonaConfig;
}
```

Add `maxTurnsPerLink: number` to `GatewayDefaults`:

```typescript
export interface GatewayDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs: number;
  maxPersistedSessions: number;
  maxTurnsPerLink: number;
  claudeArgs: string[];
}
```

In the `loadConfig` function, inside the project loop, after the existing spread for `claudeArgs`, add persona parsing:

```typescript
// After the existing claudeArgs spread in the validated[channelId] assignment
let persona: PersonaConfig | undefined;
if (p.persona && typeof p.persona === 'object') {
  const per = p.persona as Record<string, unknown>;
  if (typeof per.systemPrompt === 'string' && Array.isArray(per.canMessageChannels)) {
    persona = {
      systemPrompt: per.systemPrompt,
      canMessageChannels: per.canMessageChannels as string[],
      maxDirectivesPerTurn: typeof per.maxDirectivesPerTurn === 'number' ? per.maxDirectivesPerTurn : 1,
    };
  }
}
```

Add `...(persona && { persona })` to the `validated[channelId]` object.

Add `maxTurnsPerLink` to the defaults return:

```typescript
maxTurnsPerLink: typeof defaults.maxTurnsPerLink === 'number' ? defaults.maxTurnsPerLink : 5,
```

- [ ] **Step 4: Update existing test configs for the new `maxTurnsPerLink` field**

The `GatewayDefaults` type now requires `maxTurnsPerLink`. Update test config objects that construct `GatewayDefaults` inline to avoid type errors:

In `tests/discord.test.ts`, update `testConfig`:

```typescript
const testConfig: GatewayConfig = {
  defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [], maxTurnsPerLink: 5 },
  projects: {
    'ch-1': { name: 'Alpha', directory: '/tmp/alpha' },
    'ch-2': { name: 'Beta', directory: '/tmp/beta' },
  },
};
```

Also add `maxTurnsPerLink` and `sessionTtlMs` and `maxPersistedSessions` to any `GatewayDefaults` objects in `tests/session-manager.test.ts` and `tests/config.test.ts` if needed to satisfy types.

- [ ] **Step 5: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/discord.test.ts tests/session-manager.test.ts
git commit -m "feat: add persona config and maxTurnsPerLink to gateway config"
```

---

### Task 5: Persona Injection in Session Manager

**Files:**
- Modify: `src/session-manager.ts:37-43` (createSessionManager signature)
- Modify: `src/session-manager.ts:128-141` (processQueue)
- Modify: `tests/session-manager.test.ts`

- [ ] **Step 1: Write failing tests for persona injection**

Add to `tests/session-manager.test.ts`, inside the main `describe('SessionManager', ...)` block:

```typescript
describe('persona injection', () => {
  it('prepends system prompt to user message when persona is provided', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    const personas = new Map([
      ['project-a', {
        systemPrompt: 'You are a PM.',
        canMessageChannels: ['#engineer'],
        maxDirectivesPerTurn: 1,
      }],
    ]);
    const m = createSessionManager(defaults, undefined, personas);
    await m.send('project-a', '/tmp/a', 'Review the requirements');

    const calledPrompt = mockRun.mock.calls[0][2];
    expect(calledPrompt).toContain('[SYSTEM]');
    expect(calledPrompt).toContain('You are a PM.');
    expect(calledPrompt).toContain('---mpg-directive');
    expect(calledPrompt).toContain('POST_TO: #channel-name');
    expect(calledPrompt).toContain('[USER MESSAGE]');
    expect(calledPrompt).toContain('Review the requirements');
    m.shutdown();
  });

  it('includes available channels in directive instructions', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    const personas = new Map([
      ['project-a', {
        systemPrompt: 'You are a PM.',
        canMessageChannels: ['#engineer', '#designer'],
        maxDirectivesPerTurn: 1,
      }],
    ]);
    const m = createSessionManager(defaults, undefined, personas);
    await m.send('project-a', '/tmp/a', 'Hello');

    const calledPrompt = mockRun.mock.calls[0][2];
    expect(calledPrompt).toContain('#engineer');
    expect(calledPrompt).toContain('#designer');
    m.shutdown();
  });

  it('does not prepend system prompt when no persona is configured', async () => {
    const { runClaude } = await import('../src/claude-cli.js');
    const mockRun = vi.mocked(runClaude);

    const m = createSessionManager(defaults, undefined, new Map());
    await m.send('project-a', '/tmp/a', 'Hello');

    const calledPrompt = mockRun.mock.calls[0][2];
    expect(calledPrompt).toBe('Hello');
    m.shutdown();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: FAIL — `createSessionManager` does not accept a third argument.

- [ ] **Step 3: Implement persona injection**

Modify `src/session-manager.ts`:

Import the persona type at the top:

```typescript
import type { PersonaConfig } from './config.js';
```

Add a third parameter to `createSessionManager`:

```typescript
export function createSessionManager(defaults: {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs?: number;
  maxPersistedSessions?: number;
  claudeArgs: string[];
}, store?: SessionStore, personas?: Map<string, PersonaConfig>): SessionManager {
```

Add a helper function inside `createSessionManager`, before `processQueue`:

```typescript
function buildPrompt(projectKey: string, userMessage: string): string {
  const persona = personas?.get(projectKey);
  if (!persona) return userMessage;

  const channels = persona.canMessageChannels.join(', ');
  const directiveInstructions = persona.canMessageChannels.length > 0
    ? `\n\nTo delegate to another channel (available: ${channels}), end your response with:\n---mpg-directive\nPOST_TO: #channel-name\nyour message here\n---`
    : '';

  return `[SYSTEM]\n${persona.systemPrompt}${directiveInstructions}\n\n[USER MESSAGE]\n${userMessage}`;
}
```

In `processQueue`, change the `runClaude` call (line ~136) to use `buildPrompt`:

```typescript
const result = await runClaude(
  session.cwd,
  defaults.claudeArgs,
  buildPrompt(session.projectKey, item.prompt),
  session.sessionId,
);
```

Also update the retry call (line ~160):

```typescript
const result = await runClaude(session.cwd, defaults.claudeArgs, buildPrompt(session.projectKey, item.prompt), undefined);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: All tests PASS (including existing tests — the new parameter is optional).

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/session-manager.test.ts
git commit -m "feat: inject persona system prompts and directive instructions"
```

---

### Task 6: Extract findProjectByName to config.ts

**Files:**
- Modify: `src/config.ts`
- Modify: `src/discord.ts:50-58`

This is a small refactor needed before the discord.ts integration. The existing `findProjectByName` function in `discord.ts` is private, but the cross-post flow needs it for channel name resolution. Move it to `config.ts` and export it.

- [ ] **Step 1: Add findChannelByName to config.ts**

Add to the end of `src/config.ts`:

```typescript
export function findChannelByName(
  config: GatewayConfig,
  name: string,
): { channelId: string; name: string; directory: string } | null {
  const lower = name.toLowerCase();
  for (const [channelId, project] of Object.entries(config.projects)) {
    if (project.name.toLowerCase() === lower) {
      return { channelId, name: project.name, directory: project.directory };
    }
  }
  return null;
}
```

- [ ] **Step 2: Update discord.ts to use the shared helper**

In `src/discord.ts`, add `findChannelByName` to the import from `'./config.js'`:

```typescript
import type { GatewayConfig } from './config.js';
// becomes:
import { findChannelByName, type GatewayConfig } from './config.js';
```

Replace the private `findProjectByName` function (lines 50-58) to delegate to the shared one:

```typescript
function findProjectByName(config: GatewayConfig, name: string): { channelId: string; name: string } | null {
  return findChannelByName(config, name);
}
```

- [ ] **Step 3: Run all tests to verify no regressions**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/discord.ts
git commit -m "refactor: extract findChannelByName to config module"
```

---

### Task 7: Discord.ts Integration — Three-Way Bot Message Routing

**Files:**
- Modify: `src/discord.ts:1-261`
- Modify: `tests/discord.test.ts`

This is the largest task. It modifies the `createDiscordBot` function to handle bot messages, parse directives, cross-post, and reset loop counters on human messages.

- [ ] **Step 1: Write failing tests for the bot message routing logic**

The bot message routing is deeply coupled to Discord.js and is hard to unit test in isolation from `createDiscordBot`. Instead, add tests for a new exported helper `handleBotMessage` that encapsulates the routing decision. Add to `tests/discord.test.ts`:

```typescript
import { handleBotMessage, type BotMessageResult } from '../src/discord.js';

describe('handleBotMessage', () => {
  const configWithPersonas: GatewayConfig = {
    defaults: { idleTimeoutMs: 1800000, maxConcurrentSessions: 4, claudeArgs: [], maxTurnsPerLink: 5 },
    projects: {
      'ch-pm': { name: 'pm', directory: '/tmp/proj', persona: { systemPrompt: 'PM', canMessageChannels: ['#engineer'], maxDirectivesPerTurn: 1 } },
      'ch-eng': { name: 'engineer', directory: '/tmp/proj', persona: { systemPrompt: 'Eng', canMessageChannels: ['#pm'], maxDirectivesPerTurn: 1 } },
    },
  };

  it('returns "ignore" for messages not in either tracker', () => {
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: 'hello',
      isAgentMessage: false,
      isCrossPost: false,
      sourceChannelId: 'ch-pm',
      config: configWithPersonas,
    });
    expect(result.action).toBe('ignore');
  });

  it('returns "route-to-session" for cross-post messages', () => {
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: '**From #pm:**\nhello',
      isAgentMessage: false,
      isCrossPost: true,
      sourceChannelId: 'ch-eng',
      config: configWithPersonas,
    });
    expect(result.action).toBe('route-to-session');
  });

  it('returns "ignore" for agent message with no directive', () => {
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: 'Just a normal response.',
      isAgentMessage: true,
      isCrossPost: false,
      sourceChannelId: 'ch-pm',
      config: configWithPersonas,
    });
    expect(result.action).toBe('ignore');
  });

  it('returns "cross-post" for agent message with valid directive', () => {
    const content = 'Analysis done.\n\n---mpg-directive\nPOST_TO: #engineer\nPlease implement this.\n---';
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: content,
      isAgentMessage: true,
      isCrossPost: false,
      sourceChannelId: 'ch-pm',
      config: configWithPersonas,
    });
    expect(result.action).toBe('cross-post');
    if (result.action === 'cross-post') {
      expect(result.targetChannelId).toBe('ch-eng');
      expect(result.content).toBe('Please implement this.');
      expect(result.sourceChannelName).toBe('pm');
    }
  });

  it('returns "blocked" when target not in canMessageChannels', () => {
    const content = '---mpg-directive\nPOST_TO: #unknown\nhello\n---';
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: content,
      isAgentMessage: true,
      isCrossPost: false,
      sourceChannelId: 'ch-pm',
      config: configWithPersonas,
    });
    expect(result.action).toBe('blocked');
    if (result.action === 'blocked') {
      expect(result.reason).toContain('not allowed');
    }
  });

  it('returns "blocked" when target channel not found in config', () => {
    const content = '---mpg-directive\nPOST_TO: #nonexistent\nhello\n---';
    const result = handleBotMessage({
      messageId: 'msg-1',
      messageContent: content,
      isAgentMessage: true,
      isCrossPost: false,
      sourceChannelId: 'ch-pm',
      config: configWithPersonas,
    });
    expect(result.action).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/discord.test.ts`
Expected: FAIL — `handleBotMessage` does not exist.

- [ ] **Step 3: Implement handleBotMessage and integrate into discord.ts**

Add the following types and function to `src/discord.ts`, after the existing imports:

```typescript
import { parseDirective } from './directive-parser.js';
import { findChannelByName, type GatewayConfig, type PersonaConfig } from './config.js';
```

Add the `BotMessageResult` type and `handleBotMessage` function:

```typescript
export type BotMessageResult =
  | { action: 'ignore' }
  | { action: 'route-to-session' }
  | { action: 'cross-post'; targetChannelId: string; content: string; sourceChannelName: string }
  | { action: 'blocked'; reason: string };

export function handleBotMessage(ctx: {
  messageId: string;
  messageContent: string;
  isAgentMessage: boolean;
  isCrossPost: boolean;
  sourceChannelId: string;
  config: GatewayConfig;
}): BotMessageResult {
  if (ctx.isCrossPost) {
    return { action: 'route-to-session' };
  }

  if (!ctx.isAgentMessage) {
    return { action: 'ignore' };
  }

  const { directive } = parseDirective(ctx.messageContent);
  if (!directive) {
    return { action: 'ignore' };
  }

  // Resolve source channel persona
  const sourceProject = ctx.config.projects[ctx.sourceChannelId];
  if (!sourceProject?.persona) {
    return { action: 'blocked', reason: 'Source channel has no persona configured.' };
  }

  // Check canMessageChannels (strip # for comparison)
  const allowed = sourceProject.persona.canMessageChannels.map(c => c.replace(/^#/, '').toLowerCase());
  if (!allowed.includes(directive.targetChannel.toLowerCase())) {
    return { action: 'blocked', reason: `Posting to #${directive.targetChannel} is not allowed for this channel.` };
  }

  // Resolve target channel
  const target = findChannelByName(ctx.config, directive.targetChannel);
  if (!target) {
    return { action: 'blocked', reason: `Channel #${directive.targetChannel} not found in config.` };
  }

  return {
    action: 'cross-post',
    targetChannelId: target.channelId,
    content: directive.content,
    sourceChannelName: sourceProject.name,
  };
}
```

Then modify `createDiscordBot` to accept and use the new dependencies. Update the signature:

```typescript
import type { AgentTracker } from './agent-tracker.js';
import type { ThreadLinkRegistry } from './thread-links.js';

export function createDiscordBot(
  router: Router,
  sessionManager: SessionManager,
  config: GatewayConfig,
  agentTracker?: AgentTracker,
  threadLinks?: ThreadLinkRegistry,
): DiscordBot {
```

Replace line 169 (`if (message.author.bot) return;`) with the three-way routing:

```typescript
if (message.author.bot) {
  if (!agentTracker || !threadLinks) return;

  const isCrossPost = agentTracker.isCrossPost(message.id);
  const isAgent = agentTracker.isAgentMessage(message.id);

  if (isCrossPost) {
    // Cross-posted directive content — route to session like a human message
    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    const typingInterval = setInterval(() => {
      if ('send' in message.channel) (message.channel as TextChannel | ThreadChannel).sendTyping().catch(() => {});
    }, 7_000);
    if ('send' in message.channel) (message.channel as TextChannel | ThreadChannel).sendTyping().catch(() => {});

    try {
      const result = await sessionManager.send(
        resolved.channelId,
        resolved.directory,
        message.content,
        resolved.isThread ? { worktree: true } : undefined,
      );

      const chunks = chunkMessage(result.text, 2000);
      for (const chunk of chunks) {
        const sent = await (message.channel as TextChannel | ThreadChannel).send(chunk);
        agentTracker.track(sent.id);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await (message.channel as TextChannel | ThreadChannel).send(
        `**Error** (${resolved.name}): ${errorMsg.slice(0, 1800)}`,
      );
    } finally {
      clearInterval(typingInterval);
    }
    return;
  }

  if (isAgent) {
    const parentId = message.channel.isThread() ? message.channel.parentId ?? undefined : undefined;
    const resolved = router.resolve(message.channelId, parentId);
    if (!resolved) return;

    const botResult = handleBotMessage({
      messageId: message.id,
      messageContent: message.content,
      isAgentMessage: true,
      isCrossPost: false,
      sourceChannelId: resolved.channelId,
      config,
    });

    if (botResult.action === 'cross-post') {
      const maxTurns = config.defaults.maxTurnsPerLink;
      const sourceThread = message.channelId;

      // Find or create target thread
      let existingLink = threadLinks.getLinkedThread(sourceThread);
      let targetThread: ThreadChannel;

      if (existingLink) {
        const linkedThreadId = existingLink.sourceThread === sourceThread
          ? existingLink.targetThread
          : existingLink.sourceThread;

        if (threadLinks.isOverLimit(sourceThread, linkedThreadId, maxTurns)) {
          await (message.channel as TextChannel | ThreadChannel).send(
            `⚠️ Loop limit reached (${maxTurns} turns) — a human message in either thread will reset.`,
          );
          return;
        }

        try {
          const channel = await message.client.channels.fetch(linkedThreadId);
          if (channel && 'send' in channel) {
            targetThread = channel as ThreadChannel;
          } else {
            return;
          }
        } catch {
          return;
        }
      } else {
        // Create new thread in target channel
        try {
          const targetChannel = await message.client.channels.fetch(botResult.targetChannelId);
          if (!targetChannel || !('threads' in targetChannel)) return;
          const threadName = `From #${botResult.sourceChannelName}: ${botResult.content.slice(0, 80)}`;
          targetThread = await (targetChannel as TextChannel).threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
          });
          threadLinks.link(sourceThread, targetThread.id, botResult.sourceChannelName);
        } catch {
          return;
        }
      }

      threadLinks.recordTurn(sourceThread, targetThread.id);

      const attributedMessage = `**From #${botResult.sourceChannelName}:**\n${botResult.content}`;
      const sent = await targetThread.send(attributedMessage);
      agentTracker.trackCrossPost(sent.id);
    } else if (botResult.action === 'blocked') {
      await (message.channel as TextChannel | ThreadChannel).send(`⚠️ ${botResult.reason}`);
    }
    // 'ignore' — no directive, do nothing
    return;
  }

  // Neither agent nor cross-post — gateway status message, ignore
  return;
}
```

In the human message path, after the existing `!command` handling block and before the routing, add the loop counter reset:

```typescript
// Reset loop counter if human message is in a linked thread
if (threadLinks && message.channel.isThread()) {
  const link = threadLinks.getLinkedThread(message.channelId);
  if (link) {
    threadLinks.resetPair(link.sourceThread, link.targetThread);
  }
}
```

In the existing human message response sending (the `for (const chunk of chunks)` loop around line 238), add agent tracking:

```typescript
const chunks = chunkMessage(result.text, 2000);
for (const chunk of chunks) {
  const sent = await replyChannel.send(chunk);
  if (agentTracker) agentTracker.track(sent.id);
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS. The existing `createDiscordBot` tests still work because the new parameters are optional.

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts tests/discord.test.ts
git commit -m "feat: three-way bot message routing with cross-channel directives"
```

---

### Task 8: Wire Everything Together in cli.ts

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Read current cli.ts**

Read `src/cli.ts` to understand the current wiring.

- [ ] **Step 2: Update cli.ts to construct and pass new dependencies**

Add imports:

```typescript
import { createAgentTracker } from './agent-tracker.js';
import { createThreadLinkRegistry } from './thread-links.js';
import type { PersonaConfig } from './config.js';
```

After loading config, build the personas map:

```typescript
const personas = new Map<string, PersonaConfig>();
for (const [channelId, project] of Object.entries(config.projects)) {
  if (project.persona) {
    personas.set(channelId, project.persona);
  }
}
```

Create the tracker and registry:

```typescript
const agentTracker = createAgentTracker();
const threadLinks = createThreadLinkRegistry();
```

Pass `personas` to `createSessionManager`:

```typescript
const sessionManager = createSessionManager(config.defaults, store, personas);
```

Pass `agentTracker` and `threadLinks` to `createDiscordBot`:

```typescript
const bot = createDiscordBot(router, sessionManager, config, agentTracker, threadLinks);
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Run a build to verify compilation**

Run: `npx tsup`
Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire agent tracker, thread links, and personas into gateway startup"
```

---

### Task 9: Final Integration Test and Cleanup

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run the build**

Run: `npx tsup`
Expected: Build succeeds.

- [ ] **Step 3: Verify no lint or type errors**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Final commit if any remaining changes**

```bash
git status
# If there are changes:
git add -A && git commit -m "chore: final cleanup for cross-channel agent communication"
```
