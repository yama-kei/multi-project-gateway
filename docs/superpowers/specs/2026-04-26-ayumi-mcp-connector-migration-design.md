# Ayumi MCP Connector Migration — Design

**Date:** 2026-04-26
**Status:** Implemented (mpg#231, closes mpg#230)
**Decision context:** [HouseholdOS#160](https://github.com/yama-kei/HouseholdOS/issues/160), [mpg#228](https://github.com/yama-kei/multi-project-gateway/issues/228)

## Problem

Ayumi-family agents (`life-router`, `life-work`, `life-travel`, `life-finance`, `life-health`, `life-social`, `life-hobbies`, `life-curator`) cannot independently use the user's Gmail / Google Calendar / Google Drive when spawned by mpg. The user must remind them every conversation.

Two coupled root causes:

1. **Deferred MCP tools.** Claude Code's native `/mcp` cloud connectors (Gmail/Calendar/Drive) *are* propagated to mpg-spawned `claude` subprocesses, but they appear as *deferred* tools — listed by name in a `<system-reminder>` but with schemas not pre-loaded. The agent must call `ToolSearch` first to load each tool's schema before invoking it. Agents not told this assume they have no email access.

2. **Obsolete broker-only instruction in `life-curator`.** The current `life-curator` preset (`src/ayumi/presets.ts:239-252`) explicitly forbids using Claude MCP tools and requires the HouseholdOS broker API for Gmail/Calendar fetch. Per HouseholdOS#160, this decision has been reversed: Ayumi runs on Claude Code only, and Claude Code now ships per-tool/per-scope access controls natively, so the broker offers no remaining differentiator for Ayumi.

## Goal

Make all eight Ayumi-family personas auto-aware that they have access to Gmail / Calendar / Drive via Claude Code's native MCP connectors, and migrate `life-curator`'s extraction pipeline from the broker API to those native MCP tools — without disturbing mpg's runtime broker fallback for Drive vault reading (which `HouseholdOS#160` explicitly preserves).

## Non-goals

- Migrating mpg's runtime Drive-vault-read fallback (`src/broker-client.ts`, `src/ayumi/life-context-loader.ts`). Those continue to use the broker per HouseholdOS#160's "keep broker code in-tree" guidance.
- Removing `BROKER_*` env vars from `.env.example` — still used by Drive fallback.
- Per-persona connector toggles (e.g., `connectors: ['gmail', 'calendar']` per `AgentConfig`). Not needed today; add when a real per-persona case appears.
- Changes to `src/ayumi/curator-commands.ts` — operates on local `pending-review.json`, unaffected.
- Multi-CLI agent support (mpg#228) — orthogonal.

## Architecture

A single shared `AYUMI_CONNECTOR_INSTRUCTIONS` string constant lives at the top of `src/ayumi/presets.ts`. After the `AYUMI_PRESETS` object literal is declared, a small post-processing loop at module-load time iterates over the map and appends `\n\n${AYUMI_CONNECTOR_INSTRUCTIONS}` to each preset's `prompt` field. The export remains `AYUMI_PRESETS`.

No other source file changes. `discord.ts:252-257`'s `buildSystemPrompt` already concatenates `agent.prompt` verbatim into the spawned agent's system prompt, so the new block flows through without further wiring.

## The shared instruction block

```
## Tool access: Gmail / Google Calendar / Google Drive

You have access to the user's Gmail, Google Calendar, and Google Drive via Claude Code's
native MCP connectors. These tools are *deferred* — they appear in the system reminder's
"deferred tools" list but their schemas are not pre-loaded.

To use one, first load its schema with the ToolSearch tool, e.g.:
  ToolSearch(query: "select:mcp__claude_ai_Gmail__search_threads", max_results: 1)

Common tool name prefixes:
- Gmail:    mcp__claude_ai_Gmail__*           (search_threads, get_thread, list_drafts,
                                                list_labels, label_message, create_draft, ...)
- Calendar: mcp__claude_ai_Google_Calendar__* (list_events, get_event, list_calendars,
                                                suggest_time, create_event, update_event, ...)
- Drive:    mcp__claude_ai_Google_Drive__*    (search_files, read_file_content,
                                                list_recent_files, get_file_metadata, ...)

Notes:
- Read operations (search/list/get/read) are pre-approved and run without confirmation.
- Write operations (create/update/delete) require user approval — confirm with the user
  before invoking them, and explain what will be sent.
- Do not assume these tools are unavailable just because they aren't in the main tool list.
  They are present, just deferred. If a call fails with InputValidationError, you forgot to
  load the schema first via ToolSearch.
- If the deferred-tools list reports the connector is "no longer available", tell the user
  the connector has disconnected and ask them to reconnect via Claude Code's /mcp.
```

This block is appended verbatim to every Ayumi preset (`life-router`, `life-work`, `life-travel`, `life-finance`, `life-health`, `life-social`, `life-hobbies`, `life-curator`).

## `life-curator` migration

Surgical replacement of two contiguous sections in `src/ayumi/presets.ts`.

**Replace** lines 239-261 — currently:
- `## Broker API reference (for Gmail/Calendar fetch only)` — broker headers, env-var pulls (`$BROKER_URL`, `$BROKER_API_SECRET`, `$BROKER_TENANT_ID`, `$BROKER_ACTOR_ID`), endpoint references, the explicit `Do NOT use /mcp` line.
- `## Gmail/Calendar extraction pipeline` — references the broker endpoints in step 1 ("Fetch via broker endpoints. Process in batches of 100").

**With** an MCP-equivalent block:

```
## Gmail/Calendar extraction pipeline

1. **Fetch**: Use the Gmail and Calendar MCP tools (see "Tool access" section appended
   below) to pull messages and events for the requested time range.
   - Gmail: `mcp__claude_ai_Gmail__search_threads` to find threads matching a query, then
     `mcp__claude_ai_Gmail__get_thread` to fetch full thread bodies as needed.
   - Calendar: `mcp__claude_ai_Google_Calendar__list_events` with `timeMin` / `timeMax`.
   - Iterate over results and paginate as the tool's response indicates. Respect any
     rate-limit signals.
2. **Classify:** For each message/event, assign a topic and sensitivity tier (1=low,
   2=medium, 3=high). Skip noreply/marketing/spam senders.
3. **Summarize:** Group classified items by topic. Generate markdown files per topic with
   YAML frontmatter and [[wikilinks]]:
   - Tier 1-2: summary.md, timeline.md, entities.md (with entity pages auto-created)
   - Tier 3 (finance, health): summary.md only with minimal/abstract detail. Never include
     account numbers, diagnoses, or specific financial figures.
4. **Write:** Write files to the local vault via vault-writer. Tier 1-2 go to
   $VAULT_PATH/topics/{topic}/. Tier 3 go to $VAULT_PATH/topics/_sensitive/{topic}/. Entity
   pages are created/updated automatically.
```

**Preserved unchanged:**
- All sections above line 236 (content ingestion, topic classification, sensitivity tiers, URL/file handling, the surrounding vault-write framing, YAML frontmatter schema).
- Trust mode (currently `presets.ts:263-268`).
- Tier 3 approval flow (currently `presets.ts:270-276`).
- Verifying writes (currently `presets.ts:278-286`).

**Generalized in place:** Line 236 currently reads `CRITICAL: The vault-writer module handles file writes programmatically. Do NOT use broker Drive API for writes.` The original spirit was "vault writes never traverse an external API." With MCP Drive access introduced, that rule must extend to cover MCP Drive writes too. Update line 236 to:

```
CRITICAL: The vault-writer module handles ALL file writes programmatically. Do NOT use
any external Drive API (broker or mcp__claude_ai_Google_Drive__*) for vault writes.
Reads from Drive are fine for ingesting user-authored content; writes always go through
vault-writer.
```

The shared connector block from the previous section is then appended (covers ToolSearch mechanics, approval rules) so the curator-specific section stays compact.

## Tests

Add a small unit test file (`tests/ayumi/presets.test.ts` if absent, otherwise extend an existing one) asserting:

1. Every preset in `AYUMI_PRESETS` has `prompt` ending with the shared connector block (check for a stable substring like `"## Tool access: Gmail / Google Calendar / Google Drive"`).
2. `AYUMI_PRESETS['life-curator'].prompt` no longer contains the substrings `BROKER_URL`, `Do NOT use /mcp`, `Broker API reference`, or any `POST /broker/` reference.
3. `AYUMI_PRESETS['life-curator'].prompt` contains the new MCP tool references (`mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Google_Calendar__list_events`).

Existing `tests/ayumi/life-context-loader.test.ts` continues to test the broker Drive-fallback path — unchanged.

## Risk and rollout

- **Risk: connector disconnect at runtime.** Confirmed by experimentation: connector tools may transiently disappear (`<system-reminder>` reports "MCP server disconnected") then reappear. The shared block instructs the agent to surface this to the user and recommend reconnecting via `/mcp`, rather than silently failing.
- **Risk: tool schema rename by Anthropic.** The instruction block names tool prefixes (`mcp__claude_ai_Gmail__*`) explicitly per the user's "concrete over abstract" preference. A future Anthropic rename would require a one-line edit to the shared constant — acceptable cost.
- **Risk: in-flight curator session resumes with stale prompt.** Sessions resumed via `--resume` re-run the original system prompt from cache; old sessions will continue to mention the broker until restarted. No remediation needed — this is normal session lifecycle and the next new session picks up the change.
- **Rollout:** single PR, single mpg parent issue. No staged rollout, no feature flag.

## Tracking

- **Parent issue:** mpg, *"Migrate Ayumi presets to native Claude MCP for Gmail/Calendar/Drive (drop broker prompt dependency)"*. Body cross-links HouseholdOS#160 and this design doc.
- **No new HouseholdOS issue.** Post a comment on HouseholdOS#160 referencing the mpg parent; tick the relevant checkbox on #160 when the mpg parent closes.
- **No mpg sub-issues.** The work is one PR touching one preset file, one spec doc update, and tests.

## Out of scope (re-stated for clarity)

- mpg runtime Drive-vault-read fallback (broker-based) — preserved.
- Removing `BROKER_*` env vars or `broker-client.ts` — preserved.
- Per-persona connector toggles — YAGNI.
- mpg#228 multi-CLI work — orthogonal.
