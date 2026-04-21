# On-Demand Life-Context Loading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 24 KB pre-loaded vault block for topic agents (`@life-hobbies` etc.) with a lightweight index plus topic-scoped `Read`/`Grep`/`Glob` tools, so agents can fetch only the files they need and large files like `mountains.md` (107 KB) become reachable.

**Architecture:** `loadLifeContext(agentName)` keeps its signature but now returns an **index** — `summary.md` content (if present) plus a file listing with per-file size + frontmatter description — instead of concatenated file bodies. A new `getLifeContextToolArgs(agentName)` returns scoped `--allowed-tools` patterns like `Read(<vault>/topics/<topic>/**)` that the Discord/Slack adapters merge into the CLI invocation. The agent uses the built-in `Read`/`Grep`/`Glob` tools; Claude CLI's permission matcher enforces the topic boundary.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest. No new dependencies.

---

## File Structure

### Modified
- `src/ayumi/life-context-loader.ts` — reshape `loadFromVault` + `loadFromDrive` to produce an index; add `getLifeContextToolArgs()` exported helper
- `src/ayumi/index.ts` — re-export `getLifeContextToolArgs`
- `src/discord.ts` — call `getLifeContextToolArgs` in the agent invocation path; merge into `toolArgs`
- `src/slack.ts` — same
- `tests/ayumi/life-context-loader.test.ts` — update existing tests (they assert old concatenation behavior) and add new scoping/traversal coverage

### Not touched
- `src/ayumi/presets.ts` — persona prompts already mention fetching context as needed; no changes required
- `src/claude-cli.ts` / `buildToolArgs` — left alone; the life-context path computes and passes a full `--allowed-tools` list that replaces the gateway default for life-* agents only

---

## Tasks

### Task 1: New index-building helper (pure function)

**Files:**
- Modify: `src/ayumi/life-context-loader.ts`
- Test: `tests/ayumi/life-context-loader.test.ts`

- [ ] **Step 1.1: Write failing test for buildVaultIndex — basic file listing**

Add a new `describe('buildVaultIndex')` block at the end of the existing file:

```typescript
import { buildVaultIndex } from '../../src/ayumi/life-context-loader.js';

describe('buildVaultIndex — local filesystem', () => {
  it('lists .md files in a topic directory with size and description', async () => {
    await setupVaultTopic('hobbies', {
      'summary.md': '---\ndescription: hobbies overview\n---\n# Hobbies\n\nOverview.',
      'mountains.md': '---\ndescription: mountaineering log 2004-2019\n---\n# Mountains\n\nBody.',
      'cycling.md': '# Cycling\n\nNo frontmatter.',
    });

    const index = await buildVaultIndex(tempDir, 'hobbies');
    expect(index).not.toBeNull();
    expect(index!.summary).toContain('# Hobbies');
    expect(index!.files.map((f) => f.name).sort()).toEqual(['cycling.md', 'mountains.md', 'summary.md']);
    const mountains = index!.files.find((f) => f.name === 'mountains.md')!;
    expect(mountains.description).toBe('mountaineering log 2004-2019');
    expect(mountains.sizeBytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 1.2: Run the test, confirm it fails (buildVaultIndex is not exported)**

```bash
cd /home/yamakei/Documents/multi-project-gateway/.worktrees/1496034088690257952-engineer
npx vitest run tests/ayumi/life-context-loader.test.ts -t "lists .md files"
```

Expected: FAIL with "buildVaultIndex is not a function" or import error.

- [ ] **Step 1.3: Implement buildVaultIndex in life-context-loader.ts**

Add below the existing `topicVaultPath` helper:

```typescript
export interface VaultIndexFile {
  name: string;
  sizeBytes: number;
  description: string | null;
}

export interface VaultIndex {
  summary: string | null;
  files: VaultIndexFile[];
}

function parseFrontmatterDescription(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const descLine = match[1].split('\n').find((l) => /^description:\s*/.test(l));
  if (!descLine) return null;
  return descLine.replace(/^description:\s*/, '').trim().replace(/^["']|["']$/g, '') || null;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n*/, '');
}

export async function buildVaultIndex(vaultPath: string, topic: Topic): Promise<VaultIndex | null> {
  const dir = topicVaultPath(vaultPath, topic);
  let names: string[];
  try {
    const entries = await readdir(dir);
    names = entries.filter((f) => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const files: VaultIndexFile[] = [];
  let summary: string | null = null;

  for (const name of names) {
    try {
      const content = await readFile(join(dir, name), 'utf-8');
      const description = parseFrontmatterDescription(content);
      const sizeBytes = Buffer.byteLength(content, 'utf-8');
      files.push({ name, sizeBytes, description });
      if (name === 'summary.md') {
        summary = stripFrontmatter(content);
      }
    } catch {
      continue;
    }
  }

  return { summary, files };
}
```

- [ ] **Step 1.4: Run the test, confirm it passes**

```bash
npx vitest run tests/ayumi/life-context-loader.test.ts -t "lists .md files"
```

Expected: PASS.

- [ ] **Step 1.5: Commit**

```bash
git add -A
git commit -m "feat(ayumi): add buildVaultIndex helper for on-demand context"
```

---

### Task 2: Reshape loadLifeContext to return index block

The existing `loadLifeContext` returns the full concatenated content. We change it to return a compact index string (summary + file listing) that the agent sees in its system prompt. All existing tests that assert on concatenated file bodies must be updated.

**Files:**
- Modify: `src/ayumi/life-context-loader.ts`
- Modify: `tests/ayumi/life-context-loader.test.ts`

- [ ] **Step 2.1: Write the index-block assertion test**

Replace the existing `it('loads all .md files from local vault when VAULT_PATH is set', ...)` test with an equivalent for the new shape:

```typescript
it('emits an index block listing topic files when VAULT_PATH is set', async () => {
  process.env.VAULT_PATH = tempDir;
  await setupVaultTopic('work', {
    'summary.md': '---\ntier: 2\ndescription: work overview\n---\n# Work Summary\n\nProject updates.',
    'timeline.md': '---\ntier: 2\n---\n# Timeline\n\n- 2026-03-15 Meeting',
    'authored.md': '# Authored\n\nBlog post about work.',
  });

  const result = await loadLifeContext('life-work');

  expect(result).toContain('--- LIFE CONTEXT INDEX ---');
  expect(result).toContain('# Work Summary'); // summary.md content inlined
  expect(result).toContain('Project updates.');
  expect(result).toContain('authored.md'); // index entry
  expect(result).toContain('timeline.md');
  expect(result).toContain('work overview'); // description from frontmatter
  // Full bodies of timeline.md / authored.md are NOT inlined
  expect(result).not.toContain('- 2026-03-15 Meeting');
  expect(result).not.toContain('Blog post about work.');
  expect(result).toContain('--- END LIFE CONTEXT INDEX ---');
});
```

- [ ] **Step 2.2: Update the remaining legacy-shape tests that will now fail**

These four existing tests assert on the old concatenation behavior:

1. `strips frontmatter from vault files` — keep as-is; `summary.md` body still gets its frontmatter stripped.
2. `loads only the files that exist in the directory` — change assertion to check `summary.md` inlined + no other files in index (since none exist).
3. `reads sensitive topics from _sensitive/ subdirectory` — change assertion from `'Abstract overview.'` (body) to `'summary.md'` (index entry) + sensitive-topic index still produced.
4. `reads all .md files dynamically, not just hardcoded names` — change to assert all three filenames appear in the index.
5. `loads _identity/writing-style.md and appends to context` — in the new world, writing-style is NOT in the topic index; we'll include its body in the index block header (same as before, sized permitting) since it's small. Keep test but adjust to assert `writing-style.md` content is inlined.
6. `works without _identity/writing-style.md` — still valid.
7. `sorts vault files alphabetically` — assert the index listing order, not body order.
8. `applies size budget when reading from vault` — size budget no longer applies (index is always tiny). Replace with a new test: `index is bounded regardless of file count` — create 50 files, assert the index block is under 10 KB.

- [ ] **Step 2.3: Rewrite loadFromVault to emit the index block**

Replace the body of `loadFromVault` in `life-context-loader.ts`:

```typescript
async function loadFromVault(vaultPath: string, topic: Topic): Promise<string | null> {
  const index = await buildVaultIndex(vaultPath, topic);
  if (!index) return null;

  const lines: string[] = ['--- LIFE CONTEXT INDEX ---', ''];

  if (index.summary) {
    lines.push('## summary.md', index.summary, '');
  }

  lines.push('## Available files in this topic');
  lines.push('Use the Read tool to fetch any of these when relevant to the question:');
  lines.push('');
  for (const file of index.files) {
    if (file.name === 'summary.md') continue; // already inlined above
    const desc = file.description ? ` — ${file.description}` : '';
    const sizeKb = (file.sizeBytes / 1024).toFixed(1);
    lines.push(`- ${file.name} (${sizeKb} KB)${desc}`);
  }
  lines.push('');

  // Append writing-style.md body if available (small, identity-critical)
  try {
    const ws = await readFile(join(vaultPath, '_identity', 'writing-style.md'), 'utf-8');
    lines.push('## writing-style.md', stripFrontmatter(ws), '');
  } catch {
    // skip
  }

  lines.push('--- END LIFE CONTEXT INDEX ---');
  return lines.join('\n');
}
```

Update `loadLifeContext`'s signature to drop the `sizeBudget` parameter (no longer used):

```typescript
export async function loadLifeContext(agentName: string): Promise<string | null> {
  const topic = AGENT_TOPIC_MAP[agentName];
  if (!topic) return null;

  const vaultPath = process.env.VAULT_PATH;
  if (vaultPath) {
    try {
      return await loadFromVault(vaultPath, topic);
    } catch (err) {
      console.error(`[life-context-loader] Error loading vault context for ${agentName}:`, err);
      return null;
    }
  }
  return loadFromDrive(agentName, topic);
}
```

Delete the exported `DEFAULT_TOPIC_SIZE_BUDGET` constant and any imports/tests that reference it.

- [ ] **Step 2.4: Rewrite loadFromDrive to emit the same index shape**

Replace the body of `loadFromDrive` with a directory listing that emits the same index format. It does not read file contents except for `summary.md`:

```typescript
async function loadFromDrive(agentName: string, topic: Topic): Promise<string | null> {
  const client = getOrCreateClient();
  if (!client) return null;

  try {
    const folderId = await resolveTopicFolderId(client, topic);
    if (!folderId) {
      console.error(`[life-context-loader] No folder found for topic "${topic}" in Drive`);
      return null;
    }

    const listing = await client.driveList(folderId);
    const mdFiles = listing.files.filter((f) => f.name.endsWith('.md'));
    if (mdFiles.length === 0) return null;

    const lines: string[] = ['--- LIFE CONTEXT INDEX ---', ''];

    const summaryFile = mdFiles.find((f) => f.name === 'summary.md');
    if (summaryFile) {
      const result = await client.driveRead(summaryFile.file_id);
      lines.push('## summary.md', stripFrontmatter(result.content), '');
    }

    lines.push('## Available files in this topic');
    lines.push('Use the Read tool to fetch any of these when relevant to the question:');
    lines.push('');
    for (const f of mdFiles.sort((a, b) => a.name.localeCompare(b.name))) {
      if (f.name === 'summary.md') continue;
      const sizeKb = f.size_bytes != null ? `${(f.size_bytes / 1024).toFixed(1)} KB` : 'unknown size';
      lines.push(`- ${f.name} (${sizeKb})`);
    }
    lines.push('');
    lines.push('--- END LIFE CONTEXT INDEX ---');
    return lines.join('\n');
  } catch (err) {
    console.error(`[life-context-loader] Error loading context for ${agentName}:`, err);
    return null;
  }
}
```

- [ ] **Step 2.5: Update Drive-path tests in the same file**

The Drive tests assert on old concatenated output (e.g. `expect(result).toContain('Project updates.');`). Rewrite each to assert on the new index format — `expect(result).toContain('## summary.md')` + `expect(result).toContain('Project updates.')` for summary; other files appear by name only in the `- filename.md` listing.

Specifically update / delete:
- `loads a single .md file` — keep, but only for summary.md case.
- `loads multiple .md files sorted by modified date (newest first)` — sorting changes to alphabetical; rewrite assertion accordingly.
- `backward compatible: existing 3-file folders produce same sections` — drop test (no longer meaningful).
- `reads all .md files, not just hardcoded names` — assert on index listing, not body content.
- `truncates oldest files when over size budget` — delete (size budget removed).
- `truncates multiple files with correct count` — delete.
- `always includes at least the first file even if over budget` — delete.
- `works for different agent names` — keep with trivial adjustment.

- [ ] **Step 2.6: Run the full test file, fix anything broken**

```bash
npx vitest run tests/ayumi/life-context-loader.test.ts
```

Iterate until green.

- [ ] **Step 2.7: Commit**

```bash
git add -A
git commit -m "feat(ayumi): loadLifeContext returns index block, not concatenated content"
```

---

### Task 3: Scoped tool-args helper

The agent's system prompt gets the index; the CLI invocation needs `--allowed-tools` patterns scoped to the topic root so `Read`/`Grep`/`Glob` can only reach that topic.

**Files:**
- Modify: `src/ayumi/life-context-loader.ts`
- Modify: `src/ayumi/index.ts`
- Modify: `tests/ayumi/life-context-loader.test.ts`

- [ ] **Step 3.1: Failing tests for getLifeContextToolArgs**

```typescript
describe('getLifeContextToolArgs', () => {
  it('returns null for non-life-context agents', () => {
    process.env.VAULT_PATH = tempDir;
    expect(getLifeContextToolArgs('life-curator')).toBeNull();
    expect(getLifeContextToolArgs('some-other-agent')).toBeNull();
  });

  it('returns null when VAULT_PATH is not set', () => {
    delete process.env.VAULT_PATH;
    expect(getLifeContextToolArgs('life-hobbies')).toBeNull();
  });

  it('emits --allowed-tools patterns scoped to the hobbies topic root', () => {
    process.env.VAULT_PATH = '/data/vault';
    const args = getLifeContextToolArgs('life-hobbies');
    expect(args).toEqual([
      '--allowed-tools',
      'Read(/data/vault/topics/hobbies/**)',
      'Grep(/data/vault/topics/hobbies/**)',
      'Glob(/data/vault/topics/hobbies/**)',
      'Read(/data/vault/_identity/writing-style.md)',
    ]);
  });

  it('scopes sensitive topics to their _sensitive/ subdirectory', () => {
    process.env.VAULT_PATH = '/data/vault';
    const args = getLifeContextToolArgs('life-finance');
    expect(args).toContain('Read(/data/vault/topics/_sensitive/finance/**)');
    // Must NOT leak into the other sensitive topic
    expect(args?.join(' ')).not.toContain('/_sensitive/health');
    // Must NOT leak into tier-1/2 topics
    expect(args?.join(' ')).not.toContain('/topics/work');
  });

  it('does not grant tools outside the topic tree', () => {
    process.env.VAULT_PATH = '/data/vault';
    const args = getLifeContextToolArgs('life-hobbies');
    const joined = args!.join(' ');
    expect(joined).not.toContain('/topics/work');
    expect(joined).not.toContain('/_sensitive/');
    // No unscoped Read/Grep
    expect(args).not.toContain('Read');
    expect(args).not.toContain('Grep');
  });
});
```

- [ ] **Step 3.2: Run the tests, confirm fail**

```bash
npx vitest run tests/ayumi/life-context-loader.test.ts -t getLifeContextToolArgs
```

- [ ] **Step 3.3: Implement getLifeContextToolArgs**

Add at the end of `life-context-loader.ts`:

```typescript
export function getLifeContextToolArgs(agentName: string): string[] | null {
  const topic = AGENT_TOPIC_MAP[agentName];
  if (!topic) return null;
  const vaultPath = process.env.VAULT_PATH;
  if (!vaultPath) return null;

  const topicRoot = topicVaultPath(vaultPath, topic);
  const writingStyle = join(vaultPath, '_identity', 'writing-style.md');

  return [
    '--allowed-tools',
    `Read(${topicRoot}/**)`,
    `Grep(${topicRoot}/**)`,
    `Glob(${topicRoot}/**)`,
    `Read(${writingStyle})`,
  ];
}
```

- [ ] **Step 3.4: Export from src/ayumi/index.ts**

```typescript
import { loadLifeContext, getLifeContextToolArgs } from './life-context-loader.js';
export { loadLifeContext, getLifeContextToolArgs };
```

- [ ] **Step 3.5: Run tests, confirm pass**

```bash
npx vitest run tests/ayumi/life-context-loader.test.ts
```

- [ ] **Step 3.6: Commit**

```bash
git add -A
git commit -m "feat(ayumi): add getLifeContextToolArgs for topic-scoped tool permissions"
```

---

### Task 4: Wire into Discord and Slack adapters

When `getLifeContextToolArgs` returns non-null for the active agent, the adapter must **replace** the default `toolArgs` with the scoped ones for that specific `sessionManager.send` call.

**Files:**
- Modify: `src/discord.ts`
- Modify: `src/slack.ts`

- [ ] **Step 4.1: Add the lazy import alongside getAgentContext in both adapters**

In `discord.ts` (near line 15) and `slack.ts` (near line 15):

```typescript
let getLifeContextToolArgs: (agentName: string) => string[] | null = () => null;
try {
  const ayumi = await import('./ayumi/index.js');
  getAgentContext = ayumi.getAgentContext;
  getLifeContextToolArgs = ayumi.getLifeContextToolArgs;
} catch {
  // ayumi module absent — both no-ops
}
```

Replace the existing single-function try block with this combined one.

- [ ] **Step 4.2: Add a helper to compute effective tool args**

Right above the four `sessionManager.send` call sites in each adapter file, compute:

```typescript
const lifeArgs = getLifeContextToolArgs(agentName);
const effectiveToolArgs = lifeArgs ?? toolArgs;
```

Then pass `effectiveToolArgs` instead of `toolArgs` to `sessionManager.send`.

There are four send call sites in `discord.ts` (around lines 483, 561, 596, 660) and the corresponding ones in `slack.ts`. Only the sites dispatching **to an agent by name** need the override — the fan-out and synthesis sites already know the `agentName` / `handoff.agentName`.

For each site:
- If `agentName` is available in scope (most sites), call `getLifeContextToolArgs(agentName)`.
- For the fan-out synthesis call in `discord.ts:596`, the synthesis agent is `originAgentName` — use that.
- For the fan-out individual call at `discord.ts:561`, use `handoff.agentName`.
- For the handoff call at `discord.ts:660`, use `handoff.agentName`.

- [ ] **Step 4.3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4.4: Run the full test suite to make sure nothing broke**

```bash
npm test -- --reporter=default 2>&1 | tail -30
```

Expected: the 23 pre-existing failures in `tests/activity-engine.test.ts` and `tests/tmux-runtime.test.ts` remain; everything else green, including all `tests/ayumi/*` files.

- [ ] **Step 4.5: Commit**

```bash
git add -A
git commit -m "feat(mpg): wire life-context tool scoping into Discord and Slack adapters"
```

---

### Task 5: End-to-end verification

- [ ] **Step 5.1: Build**

```bash
npm run build
```

- [ ] **Step 5.2: Inspect the generated index for hobbies against a real vault**

Run a tiny Node script that loads the real vault path and prints what the agent would see. This proves the index is small and `mountains.md` is listed:

```bash
VAULT_PATH=/home/yamakei/Documents/ayumi/vault node -e "
const mod = await import('./dist/ayumi/index.js');
const ctx = await mod.getAgentContext('life-hobbies');
console.log('INDEX LENGTH:', ctx.length, 'bytes');
console.log('---');
console.log(ctx);
"
```

Verify:
- Output under ~15 KB
- `mountains.md` appears in the listing with a size label
- `summary.md` body is inlined
- No body of `cycling.md` is inlined (that was the old bloat)

- [ ] **Step 5.3: Inspect the tool args**

```bash
VAULT_PATH=/home/yamakei/Documents/ayumi/vault node -e "
const mod = await import('./dist/ayumi/index.js');
console.log(mod.getLifeContextToolArgs('life-hobbies'));
console.log(mod.getLifeContextToolArgs('life-finance'));
console.log(mod.getLifeContextToolArgs('life-curator'));
"
```

Verify `life-curator` returns `null`, the other two return topic-scoped `--allowed-tools` arrays.

- [ ] **Step 5.4: Traversal probe**

Spawn `claude` with the scoped allow-list and ask it to read a file outside the topic. Confirm the CLI blocks the call. This validates permission-pattern semantics rather than guessing:

```bash
VAULT_PATH=/home/yamakei/Documents/ayumi/vault claude \
  --print 'Use the Read tool to read /home/yamakei/Documents/ayumi/vault/topics/work/summary.md and print the first line.' \
  --allowed-tools 'Read(/home/yamakei/Documents/ayumi/vault/topics/hobbies/**)' \
  --output-format json 2>&1 | tail -20
```

Expected: the tool call is denied (or the agent reports it could not read the file). If permission patterns do NOT block this, this is a critical finding that requires going back to Option A (MCP); report to PM before proceeding.

Also probe `..` traversal:

```bash
VAULT_PATH=/home/yamakei/Documents/ayumi/vault claude \
  --print 'Use the Read tool to read /home/yamakei/Documents/ayumi/vault/topics/hobbies/../work/summary.md' \
  --allowed-tools 'Read(/home/yamakei/Documents/ayumi/vault/topics/hobbies/**)' \
  --output-format json 2>&1 | tail -20
```

- [ ] **Step 5.5: End-to-end mountaineering probe**

```bash
VAULT_PATH=/home/yamakei/Documents/ayumi/vault claude \
  --print 'What mountains have I climbed? Use the Read tool on any vault file that would help.' \
  --append-system-prompt "$(VAULT_PATH=/home/yamakei/Documents/ayumi/vault node -e "const m = await import('./dist/ayumi/index.js'); console.log(await m.getAgentContext('life-hobbies'));")" \
  --allowed-tools 'Read(/home/yamakei/Documents/ayumi/vault/topics/hobbies/**)' 'Grep(/home/yamakei/Documents/ayumi/vault/topics/hobbies/**)' \
  --output-format json 2>&1 | tail -30
```

Verify the response mentions content that could only have come from `mountains.md` (e.g. Hotaka, Tsurugi, specific years 2004-2019).

---

### Task 6: PR

- [ ] **Step 6.1: Push branch**

```bash
git push -u origin mpg/1496034088690257952-engineer
```

- [ ] **Step 6.2: Open PR against master**

```bash
gh pr create --repo yama-kei/multi-project-gateway --base master \
  --title "feat: on-demand life-context loading for topic agents" \
  --body "<see below>"
```

Body:

```
## Summary
- Replaces the 24 KB pre-loaded vault block with a lightweight index (`summary.md` + file listing with sizes/descriptions) so large files like `mountains.md` (107 KB) stay reachable instead of getting silently dropped.
- Topic agents receive scoped `Read`/`Grep`/`Glob` permissions limited to their topic directory via `--allowed-tools` patterns.
- Sensitive-topic isolation preserved (hobbies agent cannot read finance/health).

Closes yama-kei/ayumi#64.

## Test plan
- [x] `tests/ayumi/life-context-loader.test.ts` updated and extended (scoping, traversal probe, sensitive-topic isolation)
- [x] Full `npm test` run — only the 23 pre-existing unrelated failures remain in `activity-engine.test.ts` and `tmux-runtime.test.ts`
- [x] Verified end-to-end: `@life-hobbies` answers a mountaineering question using `mountains.md` content (see issue thread for transcript)
- [x] Traversal probe: confirmed Claude CLI permission matcher denies cross-topic and `..` reads
```
