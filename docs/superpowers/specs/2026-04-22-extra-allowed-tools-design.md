# extraAllowedTools — additive extension of the default tool allowlist

**Issue:** [#214](https://github.com/yama-kei/multi-project-gateway/issues/214)
**Date:** 2026-04-22

## Problem

Enabling a single tool outside `DEFAULT_ALLOWED_TOOLS` (e.g. `WebFetch`) today requires a user to set `defaults.allowedTools` in `gateway.json`. That field is a **full replacement**, not additive, so the user must copy the entire `DEFAULT_ALLOWED_TOOLS` list from `src/config.ts` and append the extra tool. Two consequences:

1. **Drift.** When upstream adds a tool to the default list (commit `5d746a2` added `Bash(gh:*)`, `Bash(npm:*)`, `Bash(node:*)`, `Bash(make:*)`), every user with a custom `allowedTools` silently stops inheriting those additions.
2. **Discoverability.** A user who only wants "also allow `WebFetch`" must know and re-type the full canonical list.

Motivating incident: an ayumi agent was silently denied `WebFetch` when trying to read an article, because `WebFetch` is not in the default allowlist. Adding `WebFetch` globally was rejected — the default is intentionally secure.

## Goal

Provide a per-user and per-project opt-in that extends (rather than replaces) the effective allowlist.

## Non-goals

- Do not change `DEFAULT_ALLOWED_TOOLS`. The default stays secure.
- Do not introduce a new permission mode.
- No `extraDisallowedTools` in this pass (potential future symmetry).

## Config shape

New optional field at two layers:

```jsonc
{
  "defaults": {
    "extraAllowedTools": ["WebFetch"]
  },
  "projects": {
    "12345": {
      "directory": "/path",
      "extraAllowedTools": ["WebSearch"]
    }
  }
}
```

## Merge semantics

All merging happens at config-load time in `src/config.ts`. The runtime path in `src/claude-cli.ts` (`buildToolArgs`) is unchanged — it still reads from `defaults.allowedTools` / `project.allowedTools`.

### Gateway-defaults layer

- **Base:** `defaults.allowedTools` if explicitly set, else `DEFAULT_ALLOWED_TOOLS`.
- **Effective defaults allowlist:** `[...base, ...defaults.extraAllowedTools]` with duplicates removed (first occurrence wins, order preserved).
- If both `defaults.allowedTools` and `defaults.disallowedTools` are set, the existing warning fires (unchanged).
- If `defaults.extraAllowedTools` is set alongside `defaults.disallowedTools` (without `defaults.allowedTools`), emit a warning that `extraAllowedTools` forces allow-list mode, and drop `disallowedTools` from the effective defaults. This follows the existing "allowed beats disallowed" precedent.

### Per-project layer

Determined per project:

- **Base:**
  - if `project.allowedTools` is set → `project.allowedTools`
  - else if `project.extraAllowedTools` is set → effective defaults allowlist (the merged list from above)
  - else → no project `allowedTools` is emitted (falls through to defaults as today)
- **Effective project allowlist (when emitted):** `[...base, ...project.extraAllowedTools]` deduped.
- Same warning rule: if `project.extraAllowedTools` is set alongside `project.disallowedTools`, warn and force allow-list mode.

This preserves the existing "project.allowedTools fully overrides defaults" semantic while letting `extraAllowedTools` layer on top of whichever list applies.

## Validation

- `extraAllowedTools` must be an array of strings.
- Non-array value → ignored with a warning.
- Non-string entries → filtered out.
- Empty array → treated as absent.

## Types (`src/config.ts`)

```ts
interface GatewayDefaults {
  // ...existing fields...
  extraAllowedTools?: string[];
}

interface ProjectConfig {
  // ...existing fields...
  extraAllowedTools?: string[];
}
```

Note: `extraAllowedTools` is optional on `GatewayDefaults` — it remains as a marker on the resolved config only if the user set it. After merging, consumers should rely on `defaults.allowedTools` for the effective list.

## Testing (`tests/config.test.ts`)

New cases:

1. `extraAllowedTools` at defaults only → effective `defaults.allowedTools = DEFAULT_ALLOWED_TOOLS ∪ extra`.
2. `defaults.allowedTools + defaults.extraAllowedTools` → effective = `allowedTools ∪ extra`.
3. Project-level `extraAllowedTools` with no project `allowedTools` → effective `project.allowedTools = effectiveDefaultsAllowlist ∪ projectExtra`.
4. Project-level `extraAllowedTools` layered on project-level `allowedTools` → effective = `project.allowedTools ∪ projectExtra`.
5. Duplicates collapse, order preserved (first occurrence).
6. `extraAllowedTools` + `disallowedTools` at defaults layer → warning emitted, `disallowedTools` dropped.
7. `extraAllowedTools` + `disallowedTools` at project layer → warning emitted, `disallowedTools` dropped from that project.
8. Non-array `extraAllowedTools` input → ignored, warning emitted.
9. Non-string entries filtered.
10. Backward compatibility: configs without `extraAllowedTools` behave identically to today (covered by existing tests, but add one explicit case confirming `DEFAULT_ALLOWED_TOOLS` is unchanged when only `extraAllowedTools` is absent).

## Docs

- `README.md` "Tool security" section: add a subsection documenting `extraAllowedTools`. Recommend it as the preferred way to opt in to higher-risk tools like `WebFetch`.
- `docs/ARCHITECTURE.md`: one-line note near the default-allowlist table pointing at `extraAllowedTools`.

## Acceptance criteria (from issue #214)

- [ ] `extraAllowedTools` works at both `defaults` and per-project scope.
- [ ] Merging is deduplicated and order-stable.
- [ ] New tests cover the listed cases.
- [ ] README + ARCHITECTURE docs explain the field and recommend it for opt-in cases like `WebFetch`.
- [ ] Existing configs (no `extraAllowedTools`) behave identically to today.
