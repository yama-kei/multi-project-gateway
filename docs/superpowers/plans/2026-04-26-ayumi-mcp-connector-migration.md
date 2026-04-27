# Ayumi MCP Connector Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all eight Ayumi-family personas auto-aware that they have Gmail/Calendar/Drive access via Claude Code's native MCP connectors, and migrate `life-curator`'s extraction pipeline from the HouseholdOS broker to those native tools.

**Architecture:** Single shared `AYUMI_CONNECTOR_INSTRUCTIONS` string constant in `src/ayumi/presets.ts`. After the `AYUMI_PRESETS` object literal is declared, a post-processing loop at module-load time appends `\n\n${AYUMI_CONNECTOR_INSTRUCTIONS}` to each preset's `prompt`. `life-curator`'s broker-specific section is replaced with an MCP-equivalent extraction pipeline. `discord.ts:252-257`'s `buildSystemPrompt` already concatenates `agent.prompt` verbatim, so the new block flows through with no other wiring.

**Tech Stack:** TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-26-ayumi-mcp-connector-migration-design.md`

**Decision context:** [HouseholdOS#160](https://github.com/yama-kei/HouseholdOS/issues/160), [mpg#228](https://github.com/yama-kei/multi-project-gateway/issues/228)

---

## File structure

- **Modify:** `src/ayumi/presets.ts` — add shared constant + post-processing loop; rewrite `life-curator` section.
- **Create:** `tests/ayumi/presets.test.ts` — new unit-test file (no existing presets test). Asserts shared block presence and `life-curator` migration.
- **Out of scope (this plan):** `src/broker-client.ts`, `src/ayumi/life-context-loader.ts`, `src/ayumi/curator-commands.ts`, `tests/ayumi/life-context-loader.test.ts` — all preserved per spec.
- **HouseholdOS spec update** — separate task (different repo): edit `docs/superpowers/specs/2026-03-30-life-ai-design.md` in HouseholdOS to drop broker references. Tracked in HouseholdOS#160's existing checkbox. Listed as Task 6 below for reference but executed in a HouseholdOS clone, not this worktree.

---

### Task 1: Add propagation mechanism — shared connector block appended to all 8 Ayumi presets

**Files:**
- Create: `tests/ayumi/presets.test.ts`
- Modify: `src/ayumi/presets.ts` (top: add constant; bottom: add post-processing loop)

- [ ] **Step 1.1: Write failing tests for the propagation mechanism**

Create `tests/ayumi/presets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AYUMI_PRESETS } from '../../src/ayumi/presets.js';

const AYUMI_AGENT_NAMES = [
  'life-router',
  'life-work',
  'life-travel',
  'life-finance',
  'life-health',
  'life-social',
  'life-hobbies',
  'life-curator',
] as const;

describe('AYUMI_PRESETS connector instruction propagation', () => {
  it.each(AYUMI_AGENT_NAMES)(
    'preset %s ends with the shared connector instruction block',
    (name) => {
      const preset = AYUMI_PRESETS[name];
      expect(preset, `preset ${name} should exist`).toBeDefined();
      expect(preset.prompt).toContain(
        '## Tool access: Gmail / Google Calendar / Google Drive',
      );
    },
  );

  it.each(AYUMI_AGENT_NAMES)(
    'preset %s mentions ToolSearch and the three connector prefixes',
    (name) => {
      const prompt = AYUMI_PRESETS[name].prompt;
      expect(prompt).toContain('ToolSearch');
      expect(prompt).toContain('mcp__claude_ai_Gmail__');
      expect(prompt).toContain('mcp__claude_ai_Google_Calendar__');
      expect(prompt).toContain('mcp__claude_ai_Google_Drive__');
    },
  );

  it('preset prompts mention that read ops are pre-approved and writes need confirmation', () => {
    const prompt = AYUMI_PRESETS['life-router'].prompt;
    expect(prompt).toMatch(/pre-approved/i);
    expect(prompt).toMatch(/require user approval|confirm with the user/i);
  });
});
```

- [ ] **Step 1.2: Run the new tests and confirm they fail**

```bash
cd /home/yamakei/Documents/multi-project-gateway/.worktrees/1497632978619334847
npm test -- tests/ayumi/presets.test.ts
```

Expected: tests fail because no preset's `prompt` currently contains `"## Tool access: Gmail / Google Calendar / Google Drive"`.

- [ ] **Step 1.3: Add the shared constant to `src/ayumi/presets.ts`**

Insert this constant declaration immediately after the `import` line at the top of the file (currently line 1 is `import type { AgentConfig } from '../config.js';`):

```typescript
const AYUMI_CONNECTOR_INSTRUCTIONS = [
  '## Tool access: Gmail / Google Calendar / Google Drive',
  '',
  'You have access to the user\'s Gmail, Google Calendar, and Google Drive via Claude Code\'s native MCP connectors. These tools are *deferred* — they appear in the system reminder\'s "deferred tools" list but their schemas are not pre-loaded.',
  '',
  'To use one, first load its schema with the ToolSearch tool, e.g.:',
  '  ToolSearch(query: "select:mcp__claude_ai_Gmail__search_threads", max_results: 1)',
  '',
  'Common tool name prefixes:',
  '- Gmail:    mcp__claude_ai_Gmail__*           (search_threads, get_thread, list_drafts, list_labels, label_message, create_draft, ...)',
  '- Calendar: mcp__claude_ai_Google_Calendar__* (list_events, get_event, list_calendars, suggest_time, create_event, update_event, ...)',
  '- Drive:    mcp__claude_ai_Google_Drive__*    (search_files, read_file_content, list_recent_files, get_file_metadata, ...)',
  '',
  'Notes:',
  '- Read operations (search/list/get/read) are pre-approved and run without confirmation.',
  '- Write operations (create/update/delete) require user approval — confirm with the user before invoking them, and explain what will be sent.',
  '- Do not assume these tools are unavailable just because they aren\'t in the main tool list. They are present, just deferred. If a call fails with InputValidationError, you forgot to load the schema first via ToolSearch.',
  '- If the deferred-tools list reports the connector is "no longer available", tell the user the connector has disconnected and ask them to reconnect via Claude Code\'s /mcp.',
].join('\n');
```

- [ ] **Step 1.4: Add the post-processing loop at the bottom of `src/ayumi/presets.ts`**

The file currently ends with `};` closing the `AYUMI_PRESETS` object literal (currently line 289). Append immediately after the closing `};`:

```typescript

// Append the shared connector instruction block to every Ayumi preset's prompt.
// Single source of truth for "you have Gmail/Calendar/Drive via deferred MCP tools" guidance.
for (const preset of Object.values(AYUMI_PRESETS)) {
  preset.prompt = `${preset.prompt}\n\n${AYUMI_CONNECTOR_INSTRUCTIONS}`;
}
```

- [ ] **Step 1.5: Run the new tests and confirm they pass**

```bash
npm test -- tests/ayumi/presets.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.6: Run the full test suite to confirm no regressions**

```bash
npm test
```

Expected: every test passes (life-router and life-context-loader tests in particular should be green).

- [ ] **Step 1.7: Run the build to confirm no TypeScript errors**

```bash
npm run build
```

Expected: clean build, no type errors.

- [ ] **Step 1.8: Commit**

```bash
git add tests/ayumi/presets.test.ts src/ayumi/presets.ts
git commit -m "$(cat <<'EOF'
feat(ayumi): inject shared MCP connector instructions into all Ayumi presets

Adds a single AYUMI_CONNECTOR_INSTRUCTIONS constant and a module-load-time
post-processing loop that appends it to every preset's prompt. Teaches the
spawned agent that Gmail/Calendar/Drive are available as deferred MCP tools
and how to load them via ToolSearch.

Spec: docs/superpowers/specs/2026-04-26-ayumi-mcp-connector-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migrate `life-curator` — broker section out, MCP extraction pipeline in, line-236 generalized

**Files:**
- Modify: `src/ayumi/presets.ts` (lines 236, 239-261 in the original file — line numbers may shift slightly after Task 1's additions, so locate by content)
- Modify: `tests/ayumi/presets.test.ts` (extend with curator-specific assertions)

- [ ] **Step 2.1: Add failing tests for the curator migration**

Append to `tests/ayumi/presets.test.ts` (inside a new `describe` block at the bottom of the file):

```typescript
describe('life-curator broker → MCP migration', () => {
  const curator = AYUMI_PRESETS['life-curator'].prompt;

  it('removes all broker-API references from the prompt', () => {
    expect(curator).not.toContain('BROKER_URL');
    expect(curator).not.toContain('BROKER_API_SECRET');
    expect(curator).not.toContain('Broker API reference');
    expect(curator).not.toMatch(/POST \/broker\//);
    expect(curator).not.toContain('Do NOT use /mcp');
  });

  it('uses MCP tool references in the extraction pipeline', () => {
    expect(curator).toContain('mcp__claude_ai_Gmail__search_threads');
    expect(curator).toContain('mcp__claude_ai_Gmail__get_thread');
    expect(curator).toContain('mcp__claude_ai_Google_Calendar__list_events');
  });

  it('generalizes the no-Drive-writes rule to cover both broker and MCP Drive APIs', () => {
    expect(curator).toContain('vault-writer module handles ALL file writes');
    expect(curator).toMatch(
      /Do NOT use any external Drive API \(broker or mcp__claude_ai_Google_Drive__\*\)/,
    );
  });

  it('preserves the surrounding pipeline shape (Classify, Summarize, Write steps)', () => {
    expect(curator).toContain('## Gmail/Calendar extraction pipeline');
    expect(curator).toContain('**Classify**');
    expect(curator).toContain('**Summarize**');
    expect(curator).toContain('**Write**');
    expect(curator).toContain('vault-writer');
  });
});
```

- [ ] **Step 2.2: Run the curator tests and confirm they fail**

```bash
npm test -- tests/ayumi/presets.test.ts
```

Expected: the four new `life-curator broker → MCP migration` tests fail. The `removes all broker-API references` test fails because the broker section is still present; the `uses MCP tool references` test fails because no MCP names exist yet in the curator prompt; the `generalizes the no-Drive-writes rule` test fails because line 236 still says only "broker Drive API"; the `preserves the surrounding pipeline shape` test passes (sections are still there).

- [ ] **Step 2.3: Generalize the line-236 vault-writer rule**

In `src/ayumi/presets.ts`, locate the line in the `life-curator` preset that currently reads:

```typescript
'CRITICAL: The vault-writer module handles file writes programmatically. Do NOT use broker Drive API for writes.',
```

Replace it with:

```typescript
'CRITICAL: The vault-writer module handles ALL file writes programmatically. Do NOT use any external Drive API (broker or mcp__claude_ai_Google_Drive__*) for vault writes. Reads from Drive are fine for ingesting user-authored content; writes always go through vault-writer.',
```

(Locate by searching for the substring `vault-writer module handles file writes programmatically` — the exact line number may have shifted by Task 1's additions.)

- [ ] **Step 2.4: Replace the broker section + extraction pipeline with the MCP version**

In `src/ayumi/presets.ts`, locate the contiguous block in the `life-curator` preset that starts with:

```typescript
'',
'## Broker API reference (for Gmail/Calendar fetch only)',
```

…and ends with the existing extraction pipeline's final line:

```typescript
'4. **Write**: Write files to the local vault via vault-writer. Tier 1-2 go to $VAULT_PATH/topics/{topic}/. Tier 3 go to $VAULT_PATH/topics/_sensitive/{topic}/. Entity pages are created/updated automatically.',
```

Replace that entire block with:

```typescript
'',
'## Gmail/Calendar extraction pipeline',
'',
'1. **Fetch**: Use the Gmail and Calendar MCP tools (see "Tool access" section appended below) to pull messages and events for the requested time range.',
'   - Gmail: `mcp__claude_ai_Gmail__search_threads` to find threads matching a query, then `mcp__claude_ai_Gmail__get_thread` to fetch full thread bodies as needed.',
'   - Calendar: `mcp__claude_ai_Google_Calendar__list_events` with `timeMin` / `timeMax`.',
'   - Iterate over results and paginate as the tool\'s response indicates. Respect any rate-limit signals.',
'2. **Classify**: For each message/event, assign a topic and sensitivity tier (1=low, 2=medium, 3=high). Skip noreply/marketing/spam senders.',
'3. **Summarize**: Group classified items by topic. Generate markdown files per topic with YAML frontmatter and [[wikilinks]]:',
'   - Tier 1-2: summary.md, timeline.md, entities.md (with entity pages auto-created)',
'   - Tier 3 (finance, health): summary.md only with minimal/abstract detail. Never include account numbers, diagnoses, or specific financial figures.',
'4. **Write**: Write files to the local vault via vault-writer. Tier 1-2 go to $VAULT_PATH/topics/{topic}/. Tier 3 go to $VAULT_PATH/topics/_sensitive/{topic}/. Entity pages are created/updated automatically.',
```

The "Trust mode", "Tier 3 approval flow", and "Verifying writes" sections that follow remain unchanged.

- [ ] **Step 2.5: Run the curator tests and confirm they pass**

```bash
npm test -- tests/ayumi/presets.test.ts
```

Expected: all tests in `tests/ayumi/presets.test.ts` pass (both Task 1 propagation tests and Task 2 curator tests).

- [ ] **Step 2.6: Run the full test suite**

```bash
npm test
```

Expected: every test passes. Pay special attention to `tests/ayumi/curator-commands.test.ts` and `tests/ayumi/life-context-loader.test.ts` — they should be unaffected and stay green.

- [ ] **Step 2.7: Run the build**

```bash
npm run build
```

Expected: clean build, no type errors.

- [ ] **Step 2.8: Commit**

```bash
git add tests/ayumi/presets.test.ts src/ayumi/presets.ts
git commit -m "$(cat <<'EOF'
refactor(ayumi): migrate life-curator from broker to native Claude MCP

Replaces the HouseholdOS broker API reference and the broker-based
extraction pipeline in life-curator's preset with native Claude MCP tool
references (mcp__claude_ai_Gmail__*, mcp__claude_ai_Google_Calendar__*).
Generalizes the vault-writer rule on line 236 to forbid both broker and
MCP Drive APIs as write paths.

mpg's runtime broker fallback (broker-client.ts, life-context-loader.ts)
is intentionally preserved per HouseholdOS#160.

Spec: docs/superpowers/specs/2026-04-26-ayumi-mcp-connector-migration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Push branch and open PR

**Files:** none (git/gh operations).

- [ ] **Step 3.1: Check current branch and uncommitted changes**

```bash
git status
git log --oneline -5
```

Expected: working tree clean; recent commits show the design doc, Task 1, and Task 2 commits.

- [ ] **Step 3.2: Push the branch to origin**

```bash
git push -u origin HEAD
```

Expected: branch is pushed; gh prints the PR-creation URL.

- [ ] **Step 3.3: Open the PR via gh**

```bash
gh pr create --title "feat(ayumi): native Claude MCP for Gmail/Calendar/Drive" --body "$(cat <<'EOF'
## Summary

- Adds shared `AYUMI_CONNECTOR_INSTRUCTIONS` constant injected into every Ayumi-family preset, teaching the spawned agent that Gmail/Calendar/Drive are accessible as deferred MCP tools and how to load them via `ToolSearch`.
- Migrates `life-curator`'s extraction pipeline from the HouseholdOS broker API to native Claude MCP tools (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`).
- Generalizes the curator's vault-writer rule to forbid both broker and MCP Drive APIs as vault-write paths.
- Preserves mpg's runtime broker fallback (broker-client.ts, life-context-loader.ts) per HouseholdOS#160.

**Spec:** `docs/superpowers/specs/2026-04-26-ayumi-mcp-connector-migration-design.md`
**Decision context:** HouseholdOS#160, mpg#228

## Test plan

- [ ] `npm test` — all tests pass, including new `tests/ayumi/presets.test.ts`
- [ ] `npm run build` — clean
- [ ] Manual: spawn an Ayumi agent (e.g. `@life-work`) via Discord, ask "list my recent unread emails" without prior priming. Agent should use ToolSearch to load `mcp__claude_ai_Gmail__search_threads` and respond with results.
- [ ] Manual: spawn `@life-curator` and ask it to run a Gmail/Calendar extraction over a small time window. Verify it uses MCP tools, not broker endpoints.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: gh prints the PR URL. Note it for Task 4.

---

### Task 4: Open mpg parent issue cross-linking spec, PR, and HouseholdOS#160

**Files:** none (gh operations).

- [ ] **Step 4.1: Create the mpg parent issue**

```bash
gh issue create \
  --repo yama-kei/multi-project-gateway \
  --title "Migrate Ayumi presets to native Claude MCP for Gmail/Calendar/Drive (drop broker prompt dependency)" \
  --body "$(cat <<'EOF'
## Context

Per [HouseholdOS#160](https://github.com/yama-kei/HouseholdOS/issues/160), Ayumi-the-product is Claude-only and Anthropic now ships per-tool/per-scope access controls natively in Claude Code's `/mcp` connectors. The HouseholdOS broker no longer offers a differentiator for Ayumi's Gmail/Calendar/Drive access path.

This issue tracks the prompt-level migration in mpg.

## Scope

- Add a shared `AYUMI_CONNECTOR_INSTRUCTIONS` constant to `src/ayumi/presets.ts` and append it to every Ayumi-family preset's `prompt` so the spawned agent auto-knows about Gmail/Calendar/Drive.
- Migrate `life-curator`'s extraction pipeline from broker endpoints to native MCP tools (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`).
- Tests in `tests/ayumi/presets.test.ts`.

## Out of scope

- mpg's runtime Drive-vault-read fallback in `src/broker-client.ts` and `src/ayumi/life-context-loader.ts` — preserved per HouseholdOS#160 ("keep broker code in-tree").
- Removing `BROKER_*` env vars from `.env.example` — still used by Drive fallback.
- Per-persona connector toggles — YAGNI.
- mpg#228 multi-CLI work — orthogonal.
- HouseholdOS spec doc update — separate PR in HouseholdOS, tracked by HouseholdOS#160's existing checkbox.

## Artifacts

- Design: `docs/superpowers/specs/2026-04-26-ayumi-mcp-connector-migration-design.md`
- Plan: `docs/superpowers/plans/2026-04-26-ayumi-mcp-connector-migration.md`
- PR: <FILL_IN_PR_URL_FROM_TASK_3>

## Related

- HouseholdOS#160 — upstream decision
- mpg#228 — multi-CLI strategy (orthogonal)
EOF
)"
```

Expected: gh prints the issue URL. Note the issue number.

- [ ] **Step 4.2: Update the issue body with the actual PR URL**

If the gh attempt above failed at issue-create time because of the Projects-classic deprecation issue (per saved memory `reference_gh_cli_pr_edit_workaround.md`), retry the create via the REST API:

```bash
gh api repos/yama-kei/multi-project-gateway/issues \
  -f title='Migrate Ayumi presets to native Claude MCP for Gmail/Calendar/Drive (drop broker prompt dependency)' \
  -f body='<paste body from Step 4.1>'
```

If the body needs to be updated to insert the actual PR URL after step 3.3 finished, use:

```bash
gh api -X PATCH repos/yama-kei/multi-project-gateway/issues/<ISSUE_NUMBER> \
  -f body='<updated body with real PR URL>'
```

- [ ] **Step 4.3: Link the PR back to the parent issue**

In the PR description (created in Step 3.3), append a "Closes #<ISSUE_NUMBER>" line by editing the PR body:

```bash
gh api -X PATCH repos/yama-kei/multi-project-gateway/pulls/<PR_NUMBER> \
  -f body='<original body + "\n\nCloses #<ISSUE_NUMBER>">'
```

Expected: PR shows the linked issue in the GitHub UI.

---

### Task 5: Cross-link comment on HouseholdOS#160

**Files:** none (gh operations).

- [ ] **Step 5.1: Post a comment on HouseholdOS#160 referencing the mpg parent issue and PR**

```bash
gh issue comment 160 \
  --repo yama-kei/HouseholdOS \
  --body "$(cat <<'EOF'
mpg-side implementation tracked in https://github.com/yama-kei/multi-project-gateway/issues/<MPG_ISSUE_NUMBER> (PR https://github.com/yama-kei/multi-project-gateway/pull/<PR_NUMBER>).

That work covers the second concrete-action checkbox on this issue ("Update Ayumi spec to use Claude Code's Gmail/Calendar/Drive MCP directly") at the **prompt level** — the `life-curator` preset and shared connector instructions across all Ayumi-family agents.

Still pending: edit `docs/superpowers/specs/2026-03-30-life-ai-design.md` in this repo to drop broker references (separate small PR).
EOF
)"
```

Expected: comment posts successfully. If `gh issue comment` fails on this repo for the same Projects-classic reason, fall back to:

```bash
gh api repos/yama-kei/HouseholdOS/issues/160/comments \
  -f body='<comment body>'
```

---

### Task 6 (separate repo, optional in this session): Update HouseholdOS Ayumi spec

This step is **out of scope for the current mpg worktree** but tracked here for completeness — it satisfies the second checkbox on HouseholdOS#160.

**Files:** `docs/superpowers/specs/2026-03-30-life-ai-design.md` in `yama-kei/HouseholdOS`.

Edit the Ayumi spec to remove broker-API references for Gmail/Calendar fetch and replace them with "Claude Code's native MCP connectors (`mcp__claude_ai_Gmail__*`, `mcp__claude_ai_Google_Calendar__*`, `mcp__claude_ai_Google_Drive__*`)." Open a small PR in HouseholdOS, link it back from HouseholdOS#160, and tick the corresponding checkbox.

This is intentionally not auto-executed by this plan — it requires a separate worktree on the HouseholdOS repo. The user can choose to run it as a follow-up.

---

## Self-review

**Spec coverage:**
- "Shared instruction block injected into all eight Ayumi presets" — Task 1 ✓
- "life-curator migration: remove broker section, replace with MCP-equivalent extraction pipeline" — Task 2 ✓
- "Generalize line 236 to forbid both broker and MCP Drive writes" — Task 2 (Step 2.3) ✓
- "Tests: shared block presence, broker substrings absent, MCP substrings present" — Task 1 (Step 1.1) + Task 2 (Step 2.1) ✓
- "Preserve mpg runtime broker fallback (broker-client.ts, life-context-loader.ts)" — Out-of-scope note in plan + no tasks touch those files ✓
- "Tracking: parent issue in mpg, no new HouseholdOS issue, comment on #160" — Task 4 + Task 5 ✓

**Placeholder scan:** No `TBD`, no `TODO`, no "implement later", no "similar to Task N". All code blocks contain literal content. The two placeholders that remain — `<FILL_IN_PR_URL_FROM_TASK_3>`, `<ISSUE_NUMBER>`, `<PR_NUMBER>`, `<MPG_ISSUE_NUMBER>` — are runtime values produced by earlier steps; the plan is explicit about which step produces each.

**Type consistency:** `AYUMI_CONNECTOR_INSTRUCTIONS` is referenced consistently across Step 1.3 (definition) and Step 1.4 (use). The post-processing loop mutates `preset.prompt` of type `string`, matching `AgentConfig.prompt`. No type drift.
