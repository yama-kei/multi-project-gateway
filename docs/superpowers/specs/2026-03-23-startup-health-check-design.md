# Startup Health Check for Project Directories and Claude CLI

**Issue:** #15
**Date:** 2026-03-23

## Summary

On `mpg start`, validate that the `claude` CLI is reachable and that each configured project directory exists before accepting Discord messages. Fail fast with clear error messages if any check fails.

## Motivation

- Misconfigured directories or a missing Claude CLI currently only surface as errors when a user sends a message.
- Failing fast at startup with clear error messages saves debugging time.
- Aligns with I-005 (Safe and Minimal Setup) and I-003 (Operator Owns Trust Boundary).

## Design

### Approach

Inline checks in the `start()` function in `src/cli.ts`, after `loadConfig()` succeeds and before any Discord/session objects are created. No new files.

### Checks (in order)

Extract a `runHealthChecks(config: GatewayConfig): void` function within `cli.ts` for testability. Called from `start()`.

1. **Claude CLI reachable** — `execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'ignore' })` wrapped in try/catch. Runs once (not per-project). On failure, `console.error` with install guidance and `process.exit(1)`.

2. **Project directories exist** — Iterate all `config.projects` entries, call `fs.statSync(project.directory).isDirectory()` (wrapped in try/catch) for each. This catches both missing paths and paths that are files, not directories. Collect all failures and report them together via `console.error`, then `process.exit(1)`.

This replaces the existing `console.warn` directory loop (cli.ts lines ~87-92) — that non-fatal warning becomes a fatal error.

### Error output format

```
Health check failed:
  ✗ "claude" CLI not found on PATH. Install: https://docs.anthropic.com/en/docs/claude-code
```

```
Health check failed:
  ✗ Project "RallyHub" directory not found: /home/user/rallyhub
  ✗ Project "mpg" directory not found: /home/user/mpg
```

### Testing

Add tests in `tests/cli.test.ts` for `runHealthChecks()`. Mock `fs.statSync`, `child_process.execFileSync`, and `process.exit` to verify:
- Function returns when all checks pass
- Calls `process.exit(1)` when `claude` CLI is not found
- Calls `process.exit(1)` when one or more project directories are missing or not directories
- All missing directories are reported (not just the first one)
