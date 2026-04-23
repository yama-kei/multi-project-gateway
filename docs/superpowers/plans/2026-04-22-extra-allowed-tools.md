# extraAllowedTools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, additive `extraAllowedTools` config field at both gateway-defaults and per-project scope so users can opt into tools like `WebFetch` without duplicating the canonical default allowlist.

**Architecture:** All merging happens at config-load time in `src/config.ts`. The runtime path in `src/claude-cli.ts` (`buildToolArgs`) is unchanged — it continues to read `defaults.allowedTools` / `project.allowedTools` and receives the already-merged lists. A small internal helper dedupes while preserving order (first occurrence wins). When `extraAllowedTools` is set alongside `disallowedTools` (without an explicit `allowedTools`), the config is forced into allow-list mode with a warning, consistent with the existing "allowed beats disallowed" precedent.

**Tech Stack:** TypeScript, Node.js 20+, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-22-extra-allowed-tools-design.md`

---

## File Structure

| File | Purpose |
|------|---------|
| `src/config.ts` | Adds `extraAllowedTools` to `GatewayDefaults` and `ProjectConfig` types; adds internal `parseExtraAllowedTools` validator and `mergeToolLists` deduper; merges at defaults and project layers; refactors `loadConfig` so `defaults` is processed **before** the project loop (so the project layer can layer on top of the effective default allowlist). |
| `tests/config.test.ts` | New `describe('extraAllowedTools')` block covering the 10 cases from the spec. |
| `README.md` | "Tool security" section gains an `extraAllowedTools` subsection recommending it as the preferred way to opt in to tools like `WebFetch`. Config table gets two new rows. |
| `docs/ARCHITECTURE.md` | Adds an `extraAllowedTools` row to the config-merging table; one-line note near the defaults-struct code block. |

---

## Task 1: Add internal helpers and type fields

**Files:**
- Modify: `src/config.ts` (types at lines 16–29 and 51–68; body of `loadConfig`)

- [ ] **Step 1: Write failing test for `extraAllowedTools` at defaults layer (integration-style via `loadConfig`)**

Append to `tests/config.test.ts` inside the existing top-level `describe('loadConfig', ...)` block (right after the existing `// --- allowedTools / disallowedTools ---` tests, before `// --- logLevel ---`):

```ts
  // --- extraAllowedTools ---

  it('extends DEFAULT_ALLOWED_TOOLS when only defaults.extraAllowedTools is set', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch'] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
  });
```

Run: `npx vitest run tests/config.test.ts -t 'extends DEFAULT_ALLOWED_TOOLS when only defaults.extraAllowedTools'`
Expected: FAIL — `allowedTools` equals `DEFAULT_ALLOWED_TOOLS` (no `WebFetch`).

- [ ] **Step 2: Add type fields and internal helpers to `src/config.ts`**

In `src/config.ts`, update the `ProjectConfig` interface (around lines 16–29) to add one field:

```ts
export interface ProjectConfig {
  name: string;
  directory: string;
  idleTimeoutMs?: number;
  claudeArgs?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  extraAllowedTools?: string[];
  agents?: Record<string, AgentConfig>;
  allowedRoles?: string[];
  rateLimitPerUser?: number;
  maxAttachmentSizeMb?: number;
  allowedMimeTypes?: string[];
  maxAttachmentsPerMessage?: number;
}
```

Update the `GatewayDefaults` interface (around lines 51–68) to add one field:

```ts
export interface GatewayDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  sessionTtlMs: number;
  maxPersistedSessions: number;
  claudeArgs: string[];
  allowedTools: string[];
  disallowedTools: string[];
  extraAllowedTools?: string[];
  maxTurnsPerAgent: number;
  agentTimeoutMs: number;
  stuckNotifyMs: number;
  httpPort: number | false;
  logLevel: LogLevel;
  maxAttachmentSizeMb: number;
  allowedMimeTypes: string[];
  maxAttachmentsPerMessage: number;
  persistence: RuntimePersistence;
}
```

Add two module-private helpers just above `export function loadConfig(...)` (around line 75):

```ts
function parseExtraAllowedTools(raw: unknown, label: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`Warning: ${label}.extraAllowedTools must be an array of strings — ignoring.`);
    return undefined;
  }
  const strings = (raw as unknown[]).filter((e): e is string => typeof e === 'string');
  return strings.length > 0 ? strings : undefined;
}

function mergeToolLists(base: string[], extra: string[] | undefined): string[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of [...base, ...extra]) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    result.push(tool);
  }
  return result;
}
```

- [ ] **Step 3: Refactor `loadConfig` so defaults are computed before the project loop**

Currently `loadConfig` loops projects first (lines 89–160) and processes `defaults` afterwards (lines 162–168). The project layer now needs the effective default allowlist, so hoist the defaults parsing above the project loop.

Replace the body of `loadConfig` from just after the `projects` object-type check down through the end of the function. Full new body (replacing lines 86–190):

```ts
  const projects = obj.projects as Record<string, unknown>;

  const defaults = (obj.defaults ?? {}) as Record<string, unknown>;

  const defaultExtra = parseExtraAllowedTools(defaults.extraAllowedTools, 'defaults');
  const baseDefaultAllowed = Array.isArray(defaults.allowedTools)
    ? (defaults.allowedTools as string[])
    : DEFAULT_ALLOWED_TOOLS;
  const effectiveDefaultAllowed = mergeToolLists(baseDefaultAllowed, defaultExtra);

  let defaultDisallowed = Array.isArray(defaults.disallowedTools) ? (defaults.disallowedTools as string[]) : [];
  if (Array.isArray(defaults.allowedTools) && Array.isArray(defaults.disallowedTools)) {
    console.warn('Warning: gateway defaults set both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.');
  }
  if (defaultExtra && defaultDisallowed.length > 0 && !Array.isArray(defaults.allowedTools)) {
    console.warn('Warning: gateway defaults set both extraAllowedTools and disallowedTools — extraAllowedTools forces allow-list mode; disallowedTools will be ignored.');
    defaultDisallowed = [];
  }

  const validated: Record<string, ProjectConfig> = {};

  for (const [channelId, project] of Object.entries(projects)) {
    if (!project || typeof project !== 'object') {
      throw new Error(`Project for channel ${channelId} must be an object`);
    }
    const p = project as Record<string, unknown>;
    if (typeof p.directory !== 'string' || !p.directory) {
      throw new Error(`Project for channel ${channelId} must have a "directory" string`);
    }
    let agents: Record<string, AgentConfig> | undefined;
    if (Array.isArray(p.agents)) {
      // Shorthand: ["pm", "engineer"] — resolve each as a preset
      agents = {};
      for (const entry of p.agents) {
        if (typeof entry === 'string') {
          const name = entry.toLowerCase();
          const preset = resolvePreset(name);
          if (preset) {
            agents[name] = { ...preset };
          }
        }
      }
      if (Object.keys(agents).length === 0) agents = undefined;
    } else if (p.agents && typeof p.agents === 'object') {
      agents = {};
      for (const [agentName, agentCfg] of Object.entries(p.agents as Record<string, unknown>)) {
        const ac = agentCfg as Record<string, unknown>;
        const name = agentName.toLowerCase();

        const agentTimeoutMs = typeof ac.timeoutMs === 'number' && ac.timeoutMs > 0 ? ac.timeoutMs : undefined;

        if (typeof ac.preset === 'string') {
          // Preset-based: resolve preset, then merge overrides
          const preset = resolvePreset(ac.preset);
          if (preset) {
            const role = typeof ac.role === 'string' ? ac.role : preset.role;
            const basePrompt = preset.prompt;
            const extra = typeof ac.prompt === 'string' ? ac.prompt : '';
            const prompt = extra ? `${basePrompt}\n\n${extra}` : basePrompt;
            agents[name] = { role, prompt, ...(agentTimeoutMs !== undefined && { timeoutMs: agentTimeoutMs }) };
          }
        } else if (typeof ac.role === 'string' && typeof ac.prompt === 'string') {
          // Inline: original behavior
          agents[name] = { role: ac.role, prompt: ac.prompt, ...(agentTimeoutMs !== undefined && { timeoutMs: agentTimeoutMs }) };
        }
      }
      if (Object.keys(agents).length === 0) agents = undefined;
    }

    const projectAllowedRaw = Array.isArray(p.allowedTools) ? (p.allowedTools as string[]) : undefined;
    let projectDisallowed = Array.isArray(p.disallowedTools) ? (p.disallowedTools as string[]) : undefined;
    const projectName = typeof p.name === 'string' ? p.name : channelId;
    const projectExtra = parseExtraAllowedTools(p.extraAllowedTools, `project "${projectName}"`);

    if (projectAllowedRaw && projectDisallowed) {
      console.warn(`Warning: project "${projectName}" sets both allowedTools and disallowedTools — they conflict. allowedTools takes precedence.`);
    }

    // Resolve effective project allowlist:
    //  - if project.allowedTools is set → layer projectExtra on top of it
    //  - else if project.extraAllowedTools is set → layer on top of effective defaults
    //  - else → no project allowedTools (falls through to defaults at runtime)
    let projectAllowedEffective: string[] | undefined;
    if (projectAllowedRaw) {
      projectAllowedEffective = mergeToolLists(projectAllowedRaw, projectExtra);
    } else if (projectExtra) {
      projectAllowedEffective = mergeToolLists(effectiveDefaultAllowed, projectExtra);
    }

    // Project-level extraAllowedTools + disallowedTools → force allow-list mode
    if (projectExtra && projectDisallowed && !projectAllowedRaw) {
      console.warn(`Warning: project "${projectName}" sets both extraAllowedTools and disallowedTools — extraAllowedTools forces allow-list mode; disallowedTools will be ignored.`);
      projectDisallowed = undefined;
    }

    const allowedRoles = Array.isArray(p.allowedRoles) ? (p.allowedRoles as string[]).filter(r => typeof r === 'string') : undefined;
    const rateLimitPerUser = typeof p.rateLimitPerUser === 'number' && p.rateLimitPerUser > 0 ? p.rateLimitPerUser : undefined;

    validated[channelId] = {
      name: projectName,
      directory: p.directory,
      ...(p.idleTimeoutMs !== undefined && { idleTimeoutMs: Number(p.idleTimeoutMs) }),
      ...(Array.isArray(p.claudeArgs) && { claudeArgs: p.claudeArgs as string[] }),
      ...(projectAllowedEffective && { allowedTools: projectAllowedEffective }),
      ...(projectDisallowed && { disallowedTools: projectDisallowed }),
      ...(projectExtra && { extraAllowedTools: projectExtra }),
      ...(agents && { agents }),
      ...(allowedRoles && allowedRoles.length > 0 && { allowedRoles }),
      ...(rateLimitPerUser !== undefined && { rateLimitPerUser }),
      ...(typeof p.maxAttachmentSizeMb === 'number' && { maxAttachmentSizeMb: p.maxAttachmentSizeMb }),
      ...(Array.isArray(p.allowedMimeTypes) && { allowedMimeTypes: p.allowedMimeTypes as string[] }),
      ...(typeof p.maxAttachmentsPerMessage === 'number' && { maxAttachmentsPerMessage: p.maxAttachmentsPerMessage }),
    };
  }

  return {
    defaults: {
      idleTimeoutMs: typeof defaults.idleTimeoutMs === 'number' ? defaults.idleTimeoutMs : 1800000,
      maxConcurrentSessions: typeof defaults.maxConcurrentSessions === 'number' ? defaults.maxConcurrentSessions : 4,
      sessionTtlMs: typeof defaults.sessionTtlMs === 'number' ? defaults.sessionTtlMs : 7 * 24 * 60 * 60 * 1000,
      maxPersistedSessions: typeof defaults.maxPersistedSessions === 'number' ? defaults.maxPersistedSessions : 50,
      claudeArgs: Array.isArray(defaults.claudeArgs) ? (defaults.claudeArgs as string[]) : ['--permission-mode', 'acceptEdits', '--output-format', 'json'],
      allowedTools: effectiveDefaultAllowed,
      disallowedTools: defaultDisallowed,
      ...(defaultExtra && { extraAllowedTools: defaultExtra }),
      maxTurnsPerAgent: typeof defaults.maxTurnsPerAgent === 'number' ? defaults.maxTurnsPerAgent : 5,
      agentTimeoutMs: typeof defaults.agentTimeoutMs === 'number' ? defaults.agentTimeoutMs : 3 * 60 * 1000,
      stuckNotifyMs: typeof defaults.stuckNotifyMs === 'number' ? defaults.stuckNotifyMs : 300_000,
      httpPort: defaults.httpPort === false ? false : (typeof defaults.httpPort === 'number' ? defaults.httpPort : 3100),
      logLevel: isValidLogLevel(defaults.logLevel) ? defaults.logLevel : 'info',
      maxAttachmentSizeMb: typeof defaults.maxAttachmentSizeMb === 'number' ? defaults.maxAttachmentSizeMb : 10,
      allowedMimeTypes: Array.isArray(defaults.allowedMimeTypes) ? (defaults.allowedMimeTypes as string[]) : ['image/*', 'text/*', 'application/pdf', 'application/json'],
      maxAttachmentsPerMessage: typeof defaults.maxAttachmentsPerMessage === 'number' ? defaults.maxAttachmentsPerMessage : 5,
      persistence: defaults.persistence === 'tmux' ? 'tmux' : 'direct',
    },
    projects: validated,
  };
}
```

- [ ] **Step 4: Run the new test + full config test suite**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — the new test passes and all pre-existing tests still pass.

- [ ] **Step 5: Run `tsc --noEmit` to catch type errors**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add extraAllowedTools for additive allowlist extension

Adds optional extraAllowedTools field at defaults and project scope.
Merges on top of allowedTools (or DEFAULT_ALLOWED_TOOLS when absent) with
dedup and order-stable first-occurrence-wins. Project-level extra layers
on top of project.allowedTools if set, otherwise on top of effective
defaults.

Refs #214
EOF
)"
```

---

## Task 2: Defaults-layer — allowedTools + extraAllowedTools

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

Append inside the same `loadConfig` describe block, just after the Task 1 test:

```ts
  it('extends explicit defaults.allowedTools when defaults.extraAllowedTools is also set', () => {
    const config = loadConfig({
      defaults: {
        allowedTools: ['Read', 'Bash'],
        extraAllowedTools: ['WebFetch'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Bash', 'WebFetch']);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/config.test.ts -t 'extends explicit defaults.allowedTools'`
Expected: PASS (already supported by Task 1's implementation — this test locks in the behavior).

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover defaults.allowedTools + extraAllowedTools merge"
```

---

## Task 3: Project-layer — extraAllowedTools only

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

Append after the Task 2 test:

```ts
  it('layers project.extraAllowedTools on top of effective defaults when project.allowedTools is absent', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch'] },
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          extraAllowedTools: ['WebSearch'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedTools).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'WebFetch',
      'WebSearch',
    ]);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/config.test.ts -t 'layers project.extraAllowedTools on top of effective defaults'`
Expected: PASS (Task 1 implements this).

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover project.extraAllowedTools layering on defaults"
```

---

## Task 4: Project-layer — allowedTools + extraAllowedTools

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
  it('extends project.allowedTools with project.extraAllowedTools', () => {
    const config = loadConfig({
      projects: {
        'ch-1': {
          directory: '/tmp/a',
          allowedTools: ['Read', 'Glob'],
          extraAllowedTools: ['WebFetch'],
        },
      },
    });
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read', 'Glob', 'WebFetch']);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/config.test.ts -t 'extends project.allowedTools with project.extraAllowedTools'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover project.allowedTools + extraAllowedTools merge"
```

---

## Task 5: Dedup and order stability

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
  it('deduplicates overlapping entries and preserves first-occurrence order', () => {
    const config = loadConfig({
      defaults: {
        allowedTools: ['Read', 'Edit', 'Glob'],
        // "Read" overlaps with base, and "WebFetch" appears twice in extra
        extraAllowedTools: ['Read', 'WebFetch', 'WebFetch'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Edit', 'Glob', 'WebFetch']);
  });
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/config.test.ts -t 'deduplicates overlapping entries'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover extraAllowedTools dedup and order stability"
```

---

## Task 6: Warning when extraAllowedTools + disallowedTools (both layers)

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```ts
  it('warns and drops disallowedTools when defaults set extraAllowedTools + disallowedTools', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      defaults: {
        extraAllowedTools: ['WebFetch'],
        disallowedTools: ['Bash'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway defaults set both extraAllowedTools and disallowedTools')
    );
    expect(config.defaults.disallowedTools).toEqual([]);
    expect(config.defaults.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
    warnSpy.mockRestore();
  });

  it('does not warn about extraAllowedTools + disallowedTools when allowedTools is also set (existing warning covers it)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig({
      defaults: {
        allowedTools: ['Read'],
        extraAllowedTools: ['WebFetch'],
        disallowedTools: ['Bash'],
      },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    const calls = warnSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(m => m.includes('allowedTools and disallowedTools'))).toBe(true);
    expect(calls.some(m => m.includes('extraAllowedTools and disallowedTools'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('warns and drops disallowedTools when project sets extraAllowedTools + disallowedTools', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      projects: {
        'ch-1': {
          name: 'Alpha',
          directory: '/tmp/a',
          extraAllowedTools: ['WebFetch'],
          disallowedTools: ['Bash'],
        },
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('project "Alpha" sets both extraAllowedTools and disallowedTools')
    );
    expect(config.projects['ch-1'].disallowedTools).toBeUndefined();
    expect(config.projects['ch-1'].allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'WebFetch']);
    warnSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/config.test.ts -t 'extraAllowedTools'`
Expected: PASS (warnings are already emitted by Task 1 implementation).

- [ ] **Step 3: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover extraAllowedTools + disallowedTools warning behavior"
```

---

## Task 7: Input validation

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests**

Append:

```ts
  it('ignores non-array extraAllowedTools and emits a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig({
      defaults: { extraAllowedTools: 'WebFetch' as any },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('defaults.extraAllowedTools must be an array of strings')
    );
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    warnSpy.mockRestore();
  });

  it('filters non-string entries from extraAllowedTools', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: ['WebFetch', 123, null, 'WebSearch'] as any },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual([
      ...DEFAULT_ALLOWED_TOOLS,
      'WebFetch',
      'WebSearch',
    ]);
  });

  it('treats an empty extraAllowedTools array as absent', () => {
    const config = loadConfig({
      defaults: { extraAllowedTools: [] },
      projects: { 'ch-1': { directory: '/tmp/a' } },
    });
    expect(config.defaults.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(config.defaults.extraAllowedTools).toBeUndefined();
  });

  it('leaves behavior unchanged when extraAllowedTools is absent', () => {
    const config = loadConfig({
      defaults: { allowedTools: ['Read', 'Bash'] },
      projects: { 'ch-1': { directory: '/tmp/a', allowedTools: ['Read'] } },
    });
    expect(config.defaults.allowedTools).toEqual(['Read', 'Bash']);
    expect(config.projects['ch-1'].allowedTools).toEqual(['Read']);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/config.test.ts -t 'extraAllowedTools'`
Expected: PASS.

- [ ] **Step 3: Run full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — all tests green.

- [ ] **Step 4: Commit**

```bash
git add tests/config.test.ts
git commit -m "test(config): cover extraAllowedTools input validation and absence"
```

---

## Task 8: README documentation

**Files:**
- Modify: `README.md` (Tool security section at line 40, config reference table at lines 285–299)

- [ ] **Step 1: Add `extraAllowedTools` subsection to Tool security**

In `README.md`, insert this block **after** line 86 (the `> **Disallow-only mode:** ...` blockquote) and **before** the `## Prerequisites` heading at line 88:

```markdown
**Additive opt-in (`extraAllowedTools`):** If you just want to add one or two tools on top of the defaults (for example, allowing `WebFetch` for an agent that reads articles), use `extraAllowedTools` instead of copying the full default list into `allowedTools`:

```jsonc
{
  "defaults": {
    // DEFAULT_ALLOWED_TOOLS ∪ WebFetch, deduped and order-stable
    "extraAllowedTools": ["WebFetch"]
  },
  "projects": {
    "RESEARCH_CHANNEL": {
      "directory": "/path/to/research",
      // Layers on top of effective defaults (or on top of project.allowedTools if set)
      "extraAllowedTools": ["WebSearch"]
    }
  }
}
```

`extraAllowedTools` is the recommended way to opt in to higher-risk tools like `WebFetch` because it keeps your config inheriting upstream additions to `DEFAULT_ALLOWED_TOOLS`. Setting `extraAllowedTools` alongside `disallowedTools` (without an explicit `allowedTools`) forces the config into allow-list mode and drops `disallowedTools` with a warning, matching the existing `allowedTools` precedence rule.
```

Note: the triple-backtick-jsonc code fence inside the markdown block above is intentional — paste it verbatim.

- [ ] **Step 2: Add two rows to the config reference table**

Find the rows at lines 285–286 (gateway `allowedTools` / `disallowedTools`). Insert a new row **immediately after** the `defaults.disallowedTools` row:

```markdown
| `defaults.extraAllowedTools` | string[] | (unset) | Additive allowlist extension — merged onto `allowedTools` (or `DEFAULT_ALLOWED_TOOLS`) with dedup (see [Tool security](#tool-security)) |
```

Find the rows at lines 298–299 (project `allowedTools` / `disallowedTools`). Insert after the `disallowedTools` row:

```markdown
| `projects.<channelId>.extraAllowedTools` | string[] | (unset) | Per-project additive allowlist extension — merged on top of whichever allowlist applies |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document extraAllowedTools opt-in for default allowlist"
```

---

## Task 9: ARCHITECTURE.md update

**Files:**
- Modify: `docs/ARCHITECTURE.md` (types struct near line 245; merging table near lines 264–266)

- [ ] **Step 1: Add `extraAllowedTools` to the config-merging table**

In `docs/ARCHITECTURE.md`, find the table starting around line 260:

```markdown
| Setting | Default | Project override |
|---------|---------|------------------|
| `idleTimeoutMs` | From `defaults` | `project.idleTimeoutMs` |
| `claudeArgs` | From `defaults` | Appended: `[...defaults, ...project]` |
| `allowedTools` | From `defaults` | Replaced entirely by `project.allowedTools` |
| `disallowedTools` | From `defaults` | Replaced entirely by `project.disallowedTools` |
| `agents` | None | Defined per-project only |
```

Insert a new row right after `disallowedTools`:

```markdown
| `extraAllowedTools` | Additive; extends `DEFAULT_ALLOWED_TOOLS` or `defaults.allowedTools` | Additive at project level — extends whichever allowlist applies |
```

- [ ] **Step 2: Add a one-line note near the defaults-struct code block**

Find line 268 (the existing `If claudeArgs already contains...` paragraph). Append at the end of that paragraph (same paragraph, new sentence):

```
If `extraAllowedTools` is set alongside `disallowedTools` without an explicit `allowedTools`, the config is forced into allow-list mode and `disallowedTools` is dropped with a warning.
```

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): note extraAllowedTools in config merging table"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run full test + typecheck + build**

Run:
```bash
npx vitest run
npx tsc --noEmit
npm run build
```
Expected: all pass, `dist/` rebuilt.

- [ ] **Step 2: Manual sanity check of rendered behavior**

Confirm end-to-end behavior (no commit). This project is ESM, so use `tsx` to run the source directly:

```bash
npx tsx -e "
import { loadConfig } from './src/config.ts';
const cfg = loadConfig({
  defaults: { extraAllowedTools: ['WebFetch'] },
  projects: { 'test-channel': { directory: '/tmp/test' } },
});
console.log('defaults.allowedTools:', cfg.defaults.allowedTools);
console.log('defaults.disallowedTools:', cfg.defaults.disallowedTools);
"
```
Expected output: `defaults.allowedTools` ends with `WebFetch` (after all `DEFAULT_ALLOWED_TOOLS` entries); `defaults.disallowedTools` is `[]`.

- [ ] **Step 3: No commit needed for this task** — verification only.
