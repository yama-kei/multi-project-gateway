# Life Context Drive Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable life-context topic agents to answer questions using curated data from Google Drive by pre-fetching and injecting context into their system prompts at dispatch time.

**Architecture:** A new `life-context-loader.ts` module provides `loadLifeContext(agentName)` which maps agent names to Drive topic folders, fetches files via the broker client, and returns formatted context. Two call sites in `discord.ts` (initial dispatch and handoff dispatch) call this loader and append the result to the system prompt. Topic agent preset prompts are updated to reference inline context instead of a Drive path.

**Tech Stack:** TypeScript, vitest, broker-client (HTTP client for HouseholdOS credential broker)

**Spec:** `docs/superpowers/specs/2026-03-31-life-context-drive-injection-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/life-context-loader.ts` | New — maps agent name → topic, fetches Drive files via broker, returns formatted context string |
| `tests/life-context-loader.test.ts` | New — unit tests with mock broker client |
| `src/persona-presets.ts` | Modified — update 4 topic agent prompts to reference inline context |
| `src/discord.ts` | Modified — call `loadLifeContext` at 2 injection points |

---

### Task 1: Life context loader — topic mapping and core logic

**Files:**
- Create: `tests/life-context-loader.test.ts`
- Create: `src/life-context-loader.ts`

- [ ] **Step 1: Write the failing test for topic mapping**

In `tests/life-context-loader.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrokerClient } from '../src/broker-client.js';

function createMockClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    gmailSearch: vi.fn(),
    gmailMessages: vi.fn(),
    calendarEvents: vi.fn(),
    driveRead: vi.fn(),
    driveWrite: vi.fn(),
    driveSearch: vi.fn(),
    driveCreateFolder: vi.fn(),
    driveList: vi.fn(),
    ...overrides,
  } as BrokerClient;
}

// We need to test the internal topic mapping and the public loadLifeContext function.
// Since loadLifeContext uses createBrokerClientFromEnv internally, we'll mock the module.

describe('loadLifeContext', () => {
  let loadLifeContext: typeof import('../src/life-context-loader.js').loadLifeContext;
  let mockClient: BrokerClient;

  beforeEach(async () => {
    // Reset module cache so each test gets fresh state (cached broker client)
    vi.resetModules();

    mockClient = createMockClient();

    // Mock broker-client module to return our mock
    vi.doMock('../src/broker-client.js', () => ({
      createBrokerClientFromEnv: () => mockClient,
    }));

    const mod = await import('../src/life-context-loader.js');
    loadLifeContext = mod.loadLifeContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for non-life-context agents', async () => {
    expect(await loadLifeContext('pm')).toBeNull();
    expect(await loadLifeContext('engineer')).toBeNull();
    expect(await loadLifeContext('life-router')).toBeNull();
    expect(await loadLifeContext('curator')).toBeNull();
  });

  it('returns null when folder-map.json is not found in Drive', async () => {
    mockClient.driveSearch = vi.fn().mockResolvedValue({ files: [] });

    const result = await loadLifeContext('life-work');

    expect(result).toBeNull();
    expect(mockClient.driveSearch).toHaveBeenCalledWith('folder-map.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/life-context-loader.test.ts`
Expected: FAIL — module `../src/life-context-loader.js` not found

- [ ] **Step 3: Write minimal implementation**

In `src/life-context-loader.ts`:

```ts
/**
 * Pre-fetches life-context data from Google Drive and returns a formatted
 * string to inject into a topic agent's system prompt.
 */

import { createBrokerClientFromEnv, type BrokerClient } from './broker-client.js';

const TOPIC_MAP: Record<string, string> = {
  'life-work': 'work',
  'life-travel': 'travel',
  'life-social': 'social',
  'life-hobbies': 'hobbies',
};

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 32 * 1024; // 32 KB
const TIMEOUT_MS = 5_000;

let cachedClient: BrokerClient | null = null;
let brokerUnavailable = false;

function getClient(): BrokerClient | null {
  if (brokerUnavailable) return null;
  if (cachedClient) return cachedClient;
  try {
    cachedClient = createBrokerClientFromEnv();
    return cachedClient;
  } catch {
    console.warn('[life-context] Broker env vars not configured — life-context injection disabled');
    brokerUnavailable = true;
    return null;
  }
}

export async function loadLifeContext(agentName: string): Promise<string | null> {
  const topic = TOPIC_MAP[agentName];
  if (!topic) return null;

  const client = getClient();
  if (!client) return null;

  try {
    return await withTimeout(fetchContext(client, topic, agentName), TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[life-context] Failed to load context for ${agentName}: ${msg}`);
    return null;
  }
}

async function fetchContext(client: BrokerClient, topic: string, agentName: string): Promise<string | null> {
  // Step 1: Find folder-map.json
  const searchResult = await client.driveSearch('folder-map.json');
  const mapFile = searchResult.files.find((f) => f.name === 'folder-map.json');
  if (!mapFile) return null;

  // Step 2: Read folder map to get topic folder ID
  const mapContent = await client.driveRead(mapFile.file_id);
  const folderMap = JSON.parse(mapContent.content) as { topics: Record<string, string> };
  const folderId = folderMap.topics[topic];
  if (!folderId) return null;

  // Step 3: List files in topic folder
  const listing = await client.driveList(folderId);
  if (listing.files.length === 0) return null;

  // Step 4: Read files with size/count guards
  const filesToRead = listing.files.slice(0, MAX_FILES);
  const sections: string[] = [];
  let totalBytes = 0;

  for (const file of filesToRead) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      console.warn(`[life-context] ${agentName}: aggregate size limit reached (${MAX_TOTAL_BYTES} bytes), skipping remaining files`);
      break;
    }
    const content = await client.driveRead(file.file_id);
    const text = content.content;
    if (totalBytes + text.length > MAX_TOTAL_BYTES) {
      console.warn(`[life-context] ${agentName}: skipping ${file.name} (would exceed ${MAX_TOTAL_BYTES} byte limit)`);
      continue;
    }
    totalBytes += text.length;
    sections.push(`## ${file.name}\n${text}`);
  }

  if (sections.length === 0) return null;

  const sizeKB = (totalBytes / 1024).toFixed(1);
  console.log(`[life-context] Injected ${sections.length} files / ${sizeKB}KB for ${agentName}`);

  return `\n\n--- LIFE CONTEXT DATA ---\n\n${sections.join('\n\n')}\n\n--- END LIFE CONTEXT DATA ---`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Exported for testing — resets the cached broker client. */
export function _resetForTesting(): void {
  cachedClient = null;
  brokerUnavailable = false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/life-context-loader.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/life-context-loader.ts tests/life-context-loader.test.ts
git commit -m "feat(ayumi): add life-context loader with topic mapping and Drive fetch"
```

---

### Task 2: Life context loader — success path and guard tests

**Files:**
- Modify: `tests/life-context-loader.test.ts`

- [ ] **Step 1: Write tests for success path and size/count guards**

Append to the `describe('loadLifeContext', ...)` block in `tests/life-context-loader.test.ts`:

```ts
  it('fetches and formats Drive context for life-work', async () => {
    const folderMap = {
      root: 'root-id',
      topics: { work: 'work-folder-id', travel: 't-id', finance: 'f-id', health: 'h-id', social: 's-id', hobbies: 'hb-id' },
      meta: 'meta-id',
    };

    mockClient.driveSearch = vi.fn().mockResolvedValue({
      files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json', size_bytes: 200, modified_at: '', web_view_link: null }],
    });
    mockClient.driveRead = vi.fn()
      .mockResolvedValueOnce({ name: 'folder-map.json', mime_type: 'application/json', content: JSON.stringify(folderMap) })
      .mockResolvedValueOnce({ name: 'summary.md', mime_type: 'text/markdown', content: '# Work Summary\nQ1 projects...' })
      .mockResolvedValueOnce({ name: 'timeline.md', mime_type: 'text/markdown', content: '## Jan\n- Started project X' });
    mockClient.driveList = vi.fn().mockResolvedValue({
      files: [
        { file_id: 'sum-id', name: 'summary.md', mime_type: 'text/markdown', size_bytes: 100, modified_at: '', web_view_link: null },
        { file_id: 'tl-id', name: 'timeline.md', mime_type: 'text/markdown', size_bytes: 100, modified_at: '', web_view_link: null },
      ],
    });

    const result = await loadLifeContext('life-work');

    expect(result).not.toBeNull();
    expect(result).toContain('--- LIFE CONTEXT DATA ---');
    expect(result).toContain('## summary.md');
    expect(result).toContain('# Work Summary');
    expect(result).toContain('## timeline.md');
    expect(result).toContain('--- END LIFE CONTEXT DATA ---');
    // driveList called with the work folder ID from folder-map
    expect(mockClient.driveList).toHaveBeenCalledWith('work-folder-id');
  });

  it('returns null when topic folder is empty', async () => {
    const folderMap = {
      root: 'root-id',
      topics: { work: 'work-folder-id', travel: 't-id', finance: 'f-id', health: 'h-id', social: 's-id', hobbies: 'hb-id' },
      meta: 'meta-id',
    };

    mockClient.driveSearch = vi.fn().mockResolvedValue({
      files: [{ file_id: 'map-file-id', name: 'folder-map.json', mime_type: 'application/json', size_bytes: 200, modified_at: '', web_view_link: null }],
    });
    mockClient.driveRead = vi.fn().mockResolvedValueOnce({
      name: 'folder-map.json', mime_type: 'application/json', content: JSON.stringify(folderMap),
    });
    mockClient.driveList = vi.fn().mockResolvedValue({ files: [] });

    const result = await loadLifeContext('life-work');

    expect(result).toBeNull();
  });

  it('returns null when broker API throws', async () => {
    mockClient.driveSearch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await loadLifeContext('life-travel');

    expect(result).toBeNull();
  });

  it('maps all four topic agents correctly', async () => {
    // Just verify non-null agents reach the broker (they'll fail at search, returning null)
    mockClient.driveSearch = vi.fn().mockResolvedValue({ files: [] });

    for (const agent of ['life-work', 'life-travel', 'life-social', 'life-hobbies']) {
      await loadLifeContext(agent);
    }

    expect(mockClient.driveSearch).toHaveBeenCalledTimes(4);
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/life-context-loader.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 3: Commit**

```bash
git add tests/life-context-loader.test.ts
git commit -m "test(ayumi): add success path and error handling tests for life-context loader"
```

---

### Task 3: Update topic agent system prompts

**Files:**
- Modify: `src/persona-presets.ts`
- Modify: `tests/persona-presets.test.ts` (if prompt text is asserted)

- [ ] **Step 1: Check if existing tests assert on the prompt text**

Run: `npx vitest run tests/persona-presets.test.ts`
Note whether any tests assert on the "Google Drive" text. If so, they'll need updating.

- [ ] **Step 2: Update the four topic agent prompts**

In `src/persona-presets.ts`, change each topic agent's Drive reference. Replace these four lines:

Line 139 (`life-work`):
```
Old: 'Your knowledge comes from curated context files in Google Drive under /life-context/work/.',
New: 'Your knowledge comes from curated context data provided below in a LIFE CONTEXT DATA section.',
```

Line 157 (`life-travel`):
```
Old: 'Your knowledge comes from curated context files in Google Drive under /life-context/travel/.',
New: 'Your knowledge comes from curated context data provided below in a LIFE CONTEXT DATA section.',
```

Line 175 (`life-social`):
```
Old: 'Your knowledge comes from curated context files in Google Drive under /life-context/social/.',
New: 'Your knowledge comes from curated context data provided below in a LIFE CONTEXT DATA section.',
```

Line 193 (`life-hobbies`):
```
Old: 'Your knowledge comes from curated context files in Google Drive under /life-context/hobbies/.',
New: 'Your knowledge comes from curated context data provided below in a LIFE CONTEXT DATA section.',
```

- [ ] **Step 3: Run preset tests to verify nothing breaks**

Run: `npx vitest run tests/persona-presets.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/persona-presets.ts
git commit -m "fix(ayumi): update topic agent prompts to reference inline context data"
```

---

### Task 4: Integrate loader into discord.ts dispatch points

**Files:**
- Modify: `src/discord.ts`

- [ ] **Step 1: Add the import**

At the top of `src/discord.ts`, after the existing imports (after line 11), add:

```ts
import { loadLifeContext } from './life-context-loader.js';
```

- [ ] **Step 2: Update initial agent dispatch to inject Drive context**

Find the block where `systemPrompt` is built (currently around line 365):

```ts
    const systemPrompt = activeAgent
      ? `Your role: ${activeAgent.agent.role}\n\n${activeAgent.agent.prompt}`
      : undefined;
```

Replace with:

```ts
    let systemPrompt: string | undefined;
    if (activeAgent) {
      const base = `Your role: ${activeAgent.agent.role}\n\n${activeAgent.agent.prompt}`;
      const context = await loadLifeContext(activeAgent.agentName);
      systemPrompt = context ? `${base}${context}` : base;
    }
```

- [ ] **Step 3: Update handoff dispatch to inject Drive context**

Find the block where `handoffPrompt` is built (currently around line 465):

```ts
          const handoffPrompt = `Your role: ${handoff.agent.role}\n\n${handoff.agent.prompt}`;
```

Replace with:

```ts
          const handoffBase = `Your role: ${handoff.agent.role}\n\n${handoff.agent.prompt}`;
          const handoffContext = await loadLifeContext(handoff.agentName);
          const handoffPrompt = handoffContext ? `${handoffBase}${handoffContext}` : handoffBase;
```

- [ ] **Step 4: Run the full test suite to verify nothing breaks**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts
git commit -m "feat(ayumi): inject Drive context into life-context agent system prompts"
```

---

### Task 5: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compilation check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run linter if configured**

Run: `npx eslint src/life-context-loader.ts src/discord.ts src/persona-presets.ts` (or equivalent)
Expected: No errors

- [ ] **Step 4: Commit any lint fixes if needed**

```bash
git add -A
git commit -m "chore: lint fixes for life-context Drive injection"
```
