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

1. **Claude CLI reachable** — `execFileSync('claude', ['--version'])` wrapped in try/catch. Runs once (not per-project). On failure, log error with install guidance and `process.exit(1)`.

2. **Project directories exist** — Iterate all `config.projects` entries, call `fs.existsSync(project.directory)` for each. Collect all missing directories and report them together, then `process.exit(1)`.

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

Add tests in `tests/cli.test.ts` that mock `fs.existsSync` and `child_process.execFileSync` to verify:
- Startup proceeds when all checks pass
- Startup exits when `claude` CLI is not found
- Startup exits when one or more project directories are missing
- All missing directories are reported (not just the first one)
