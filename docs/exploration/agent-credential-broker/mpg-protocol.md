# mpg Credential and Permission Protocol: Current State Formalization

**Date:** 2026-03-24
**Status:** Exploratory — formalizing implicit behavior, not prescribing changes

## Purpose

This document formalizes the credential and permission patterns that multi-project-gateway (mpg) currently implements implicitly. mpg is a Discord-to-Claude CLI routing layer: it maps Discord channels to project directories and spawns Claude CLI processes to handle messages. It is a "thin layer" — it routes, Claude CLI executes.

The goal here is not to propose architectural changes but to name what is actually happening at each trust boundary, so that any future protocol work (such as a credential broker, per-user authorization, or formal audit trail) starts from an accurate baseline rather than assumptions about the code.

Each of the seven sections below documents one aspect of the security model in three parts:

- **Current behavior** — what the code does, with exact file:line references
- **Implicit assumptions** — security properties assumed but not enforced by code
- **Protocol gap** — what a formal protocol would need to address

---

## 1. Identity Model

### Current behavior

mpg has no concept of a per-user identity. The only identity check is a bot-message filter in `src/discord.ts:169`:

```
if (message.author.bot) return;
```

All other Discord users — regardless of who they are or what role they hold in the server — are treated identically. The `message.author` field is available on every message but is never inspected beyond the `bot` flag. Channel membership in Discord is the sole access gate: if a user can post to a mapped channel, they have full access to the corresponding Claude session.

Session IDs are Claude CLI UUIDs. They are stored in plaintext in `.sessions.json`, written by `src/session-store.ts:37-43` using `writeFileSync`. The `PersistedSession` interface (`src/session-store.ts:4-11`) stores `sessionId`, `projectKey`, `cwd`, `lastActivity`, and optionally `worktreePath` and `projectDir` — no user identity field exists.

All Claude CLI processes are spawned as the OS user running the gateway (`src/claude-cli.ts:58`). There is no `uid`/`gid` switching, no per-user process isolation, and no mechanism to attribute a running Claude process to a specific Discord user (tracked as issue #24).

### Implicit assumptions

- Discord channel access control is the operator's responsibility. The gateway assumes the operator has restricted channel membership to trusted users.
- A Discord user's identity (snowflake ID, username) is available in every message object but is assumed to be irrelevant to authorization.
- The OS user running the gateway is assumed to have appropriate access to all configured project directories and no more.
- Plaintext session IDs in `.sessions.json` are assumed to be accessible only to the operator (i.e., no multi-tenant deployment is assumed).

### Protocol gap

A formal identity model would need to:

- Define a principal type that maps a Discord user (snowflake ID) to a set of allowed projects and permissions.
- Attach a principal identifier to every session and every Claude invocation so actions can be attributed.
- Store session records with a `userId` or `principalId` field alongside the Claude session ID.
- Define what "bot message" filtering means in a multi-bot or webhook scenario (currently any `author.bot = true` message is silently dropped, which may suppress legitimate automation).

---

## 2. Credential Model

### Current behavior

mpg handles two credentials:

**Discord bot token.** Written to `.env` by `src/init.ts:37`:
```
writeFileSync(envPath, `DISCORD_BOT_TOKEN=${token}\n`);
```
Loaded at startup by `src/cli.ts:65`:
```
loadEnv({ path: envPath });
```
Read from the environment at `src/cli.ts:68`:
```
const token = process.env.DISCORD_BOT_TOKEN;
```
The token is passed directly to `client.login(token)` in `src/discord.ts:253`. It is never encrypted, hashed, or rotated by the gateway.

**Claude API key.** Not stored or managed by mpg at all. The gateway delegates entirely to Claude CLI, which manages its own authentication (API key via environment variable or `~/.claude` config). The gateway has no knowledge of the Claude API key and cannot inspect, rotate, or revoke it. This is consistent with the "thin layer" intent documented in I-004 (`INTENTS.md:74-95`).

No credential scoping exists: every session across all projects shares the same OS-level credentials — the same Discord bot token and the same Claude CLI authentication context.

### Implicit assumptions

- `.env` is assumed to be outside version control and readable only by the operator.
- The Claude CLI's credential store (`~/.claude`) is assumed to be secured at the OS level.
- All projects configured in `config.json` are assumed to be acceptable targets for the single Claude CLI identity. There is no mechanism to use different Claude API keys for different projects.
- Credential leakage via Claude's output is out of scope — it is assumed that Claude CLI will not expose its own API key in responses.

### Protocol gap

A formal credential model would need to:

- Define credential types (bot token, Claude API key) with associated scopes and lifetimes.
- Specify a rotation mechanism for the Discord bot token that does not require a gateway restart.
- Define whether per-project Claude API keys are in scope (they would require the gateway to inject `ANTHROPIC_API_KEY` into each Claude subprocess's environment, bypassing the "thin layer" model).
- Address the plaintext storage of the Discord bot token — at minimum, note that OS-level file permissions are the only protection.
- Define a revocation path: what happens when a token is compromised while the gateway is running.

---

## 3. Permission Model

### Current behavior

Permission enforcement has two layers, both of which are configured externally to mpg's core routing logic.

**Workspace boundary.** Each Claude CLI process is spawned with a `cwd` parameter (`src/claude-cli.ts:58-61`):
```
const proc = spawn('claude', args, {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```
The `cwd` value originates from the project's `directory` field in `config.json` (for main channel sessions) or the worktree path (for thread sessions). Claude CLI's default behavior restricts file access to the working directory. This boundary is enforced by Claude CLI, not by mpg.

**Permission mode.** The default `claudeArgs` in `src/config.ts:59` are:
```
['--permission-mode', 'acceptEdits', '--output-format', 'json']
```
The same defaults appear in `src/init.ts:107`. The `--permission-mode acceptEdits` flag is passed to Claude CLI as a CLI argument; mpg does not interpret or validate it. I-001 (`INTENTS.md:22`) explicitly notes this is "enforced via CLI flags, not OS-level sandboxing."

**Historical note on permission defaults.** The original design used `--dangerously-skip-permissions` as the default. This is still present in test fixtures (`tests/claude-cli.test.ts:38`, `tests/config.test.ts:10`), the original design spec (`docs/superpowers/specs/2026-03-20-multi-project-gateway-design.md:59,96`), and early plan documents. The current default of `--permission-mode acceptEdits` represents a security tightening that occurred during development. The test fixtures retain the older default, meaning the test baseline does not reflect the current security posture.

**Tool allowlisting.** README.md:32 documents that `--allowed-tools` can be used in `claudeArgs` to restrict which Claude tools are available. This is not programmatically enforced by mpg — it requires the operator to manually add the flag to `config.json`. There is no validation that `claudeArgs` does not contain dangerous overrides.

**Concurrency cap.** `src/session-manager.ts:98-109` implements an `acquireSlot()`/`releaseSlot()` semaphore. The default cap is `maxConcurrentSessions: 4` (`src/config.ts:56`). This limits resource exhaustion but is not a security boundary — it does not prevent any particular user from consuming all slots.

**No per-user permissions.** All Discord users in a mapped channel have identical access. There is no mechanism for read-only access, command filtering, or per-user tool restrictions.

### Implicit assumptions

- The operator is assumed to understand that `claudeArgs` controls Claude's permission scope and that incorrect configuration can expose the filesystem.
- `--permission-mode acceptEdits` is assumed to prevent arbitrary shell command execution. The actual enforcement is delegated to Claude CLI and Anthropic's implementation of that mode.
- The `cwd` boundary is assumed to be a meaningful filesystem restriction. In practice, Claude could read symlinks that escape the project directory unless Claude CLI's sandbox explicitly prevents this.
- No operator action in `config.json` (such as adding `--dangerously-skip-permissions`) is validated or warned against by the gateway at startup.

### Protocol gap

A formal permission model would need to:

- Define a permission schema separate from `claudeArgs` — a structured object that the gateway validates, rather than an opaque string array passed through.
- Validate at startup that `claudeArgs` does not contain known dangerous flags without explicit operator acknowledgment.
- Define per-user permission levels (e.g., read-only vs. read-write, allowed tool sets).
- Specify whether the `cwd` boundary is a hard enforcement boundary or a soft default, and under what conditions it can be widened.
- Address symlink escape and other filesystem boundary violations that `cwd` alone does not prevent.
- Define what happens when `--permission-mode` values evolve in future Claude CLI releases.

---

## 4. Isolation Model

### Current behavior

mpg provides two forms of isolation, both of which are software-level rather than OS-level.

**Worktree isolation.** Thread sessions receive isolated git worktrees. `src/discord.ts:228` passes `{ worktree: true }` for thread messages:
```
resolved.isThread ? { worktree: true } : undefined
```
`src/session-manager.ts:200` calls `gitCreateWorktree(cwd, projectKey)` when `useWorktree` is true. `src/worktree.ts:12-33` runs `git worktree add -b mpg/{key} {path}` in the project directory. The worktree is a separate filesystem path with its own branch, giving each thread a snapshot of the project's git state. Main channel sessions share the project directory directly.

Worktrees persist on idle: `src/session-manager.ts:122-125` removes the session from memory on idle timeout but explicitly does not remove the worktree:
```
// Remove from memory only; session ID and worktree stay on disk for later resume.
// Worktrees persist on idle intentionally — cleaned up on !kill or startup reconciliation.
sessions.delete(session.projectKey);
```
Orphaned worktrees are cleaned up at startup via `reconcileWorktrees()` (`src/cli.ts:110-112`, `src/worktree.ts:82-96`).

**Process isolation.** Each Claude CLI invocation is a separate OS process spawned by `spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })` (`src/claude-cli.ts:58-61`). Processes do not share memory. Each process's stdout and stderr are piped separately. However, all processes run as the same OS user, share the same environment, and share access to `~/.claude`.

**No container or namespace isolation.** I-001 (`INTENTS.md:22`) marks this as "At Risk." There is no use of Linux namespaces, cgroups, Docker, or any other OS-level isolation. A Claude CLI process with `--dangerously-skip-permissions` or a sufficiently capable tool set could access the entire filesystem, network, and other processes belonging to the gateway's OS user.

### Implicit assumptions

- Git worktree isolation is assumed to provide meaningful state separation between thread sessions. In practice, worktrees share the same git object store and can access the same remote; the isolation is at the working-tree level, not the repository level.
- Process-level isolation is assumed to be sufficient for single-operator deployments where all projects belong to the same operator.
- The operator's OS user is assumed to have a limited blast radius (i.e., not running as root).

### Protocol gap

A formal isolation model would need to:

- Define the intended isolation granularity for each session type (main channel vs. thread vs. project).
- Specify the boundary between git worktree isolation (file-level) and process isolation (memory/environment-level).
- Define requirements for OS-level isolation (namespaces, containers) if multi-tenant or untrusted-user scenarios are in scope.
- Address the shared `~/.claude` environment — all Claude CLI processes potentially share the same authentication context and any per-user configuration in that directory.
- Define the lifecycle of worktrees explicitly: when they are created, when they are cleaned up, and what data they contain after a session ends.

---

## 5. Session Lifecycle

### Current behavior

Sessions have a defined in-memory lifecycle but an implicit on-disk lifecycle.

**Idle timeout.** Default 30 minutes (`src/config.ts:55`: `idleTimeoutMs: 1800000`). Implemented in `src/session-manager.ts:117-126` via `resetIdleTimer()`. On timeout, the session is removed from the in-memory map (`sessions.delete(session.projectKey)`) but the session ID and worktree remain on disk.

**TTL.** Default 7 days (`src/config.ts:57`: `sessionTtlMs: 7 * 24 * 60 * 60 * 1000`). Enforced by `pruneSessions()` at startup (`src/session-manager.ts:51-75`). Sessions older than TTL are deleted from the persisted map. This runs once at startup, not continuously.

**Session cap.** Default 50 persisted sessions (`src/config.ts:58`: `maxPersistedSessions: 50`). Enforced by the same `pruneSessions()` function: if the count exceeds the cap after TTL pruning, the oldest sessions (by `lastActivity`) are evicted (`src/session-manager.ts:64-70`).

**Resume.** `src/claude-cli.ts:26-29` passes `--resume SESSION_ID` when a `sessionId` is present:
```
if (sessionId) {
  args.push('--resume', sessionId);
}
```
Resume happens with no re-authentication. The session ID stored in `.sessions.json` is sufficient to resume a Claude CLI session from any process running as the same OS user. The `status` command in `src/cli.ts:132-177` exposes all session IDs and their `cwd` paths by reading `.sessions.json` directly.

**Session reset on error.** `src/session-manager.ts:157-165` implements automatic session reset: if a Claude invocation fails and a session ID is in use, the session ID is cleared and the invocation is retried without `--resume`. This silently drops session context without any user intervention.

### Implicit assumptions

- The 30-minute idle timeout is assumed to be sufficient to bound resource consumption from abandoned sessions.
- The 7-day TTL is assumed to be sufficient to prevent indefinite accumulation of session state.
- Startup-only TTL pruning is assumed to be acceptable — sessions are never pruned during a running gateway instance.
- `--resume` with a session ID is assumed to be safe because session IDs are UUIDs that cannot be guessed. The threat model does not include an attacker who has read access to `.sessions.json`.
- Automatic session reset on error is assumed to be acceptable behavior. The user is notified via a Discord message (`src/discord.ts:232`) but not prompted to confirm.

### Protocol gap

A formal session lifecycle protocol would need to:

- Define session state transitions explicitly (created, active, idle, expired, dead).
- Specify whether session resumption requires re-validation of any kind (e.g., confirming the Discord user who resumes a session is the same one who created it).
- Address continuous TTL enforcement — sessions created just before a gateway restart could persist beyond their intended TTL.
- Define behavior when `.sessions.json` is corrupted or tampered with.
- Specify whether automatic session reset on error is a security-relevant event (it discards conversation history silently at the Claude CLI level).
- Define maximum session age independent of `lastActivity` — a session that is active continuously has no upper bound on age under the current model.

---

## 6. Audit and Attribution

### Current behavior

mpg has no persistent audit trail. All observability is through console logging.

**Console logging.** Startup events are logged (`src/cli.ts:91`: `Loaded N project(s)`; `src/discord.ts:254`: `Gateway connected as`). Session pruning is logged (`src/session-manager.ts:229`: `Pruned N expired session(s)`; `src/session-manager.ts:249`: `Restored N session(s)`). Worktree reconciliation is logged (`src/worktree.ts:94`). These logs go to stdout/stderr and are not persisted by the gateway.

**No per-message audit trail.** The `Events.MessageCreate` handler in `src/discord.ts:168-249` processes every message but logs nothing about what message was received, from whom, or what Claude returned. The only observable side effects are the Discord reaction (`message.react('👀')`, `src/discord.ts:195`) and the reply in the thread.

**No user identity in session records.** The `PersistedSession` interface (`src/session-store.ts:4-11`) contains `sessionId`, `projectKey`, `cwd`, `lastActivity`, `worktreePath`, and `projectDir`. There is no `userId`, `username`, or `discordMessageId` field. A session record on disk cannot be traced back to the Discord user who initiated it.

**Session activity as timestamp only.** `InternalSession.lastActivity` (`src/session-manager.ts:8`) is updated on every Claude response (`src/session-manager.ts:148`). It records when the session was last used but not what was requested or by whom.

**Session IDs visible in Discord.** The `!session` and `!sessions` commands (`src/discord.ts:93-122`) expose session IDs (truncated to 8 characters) to any user in a mapped channel. The full session ID is stored in `.sessions.json` and visible via `mpg status`.

### Implicit assumptions

- Console logging to stdout is assumed to be captured by the operator's process supervisor (e.g., systemd, pm2) and retained for a sufficient period.
- The absence of a per-message audit trail is assumed to be acceptable because the operator trusts all users in mapped channels.
- The `lastActivity` timestamp is assumed to be sufficient for operational purposes (detecting stale sessions) without needing a full activity log.
- Exposing session IDs in Discord is assumed to be safe because only trusted users have channel access.

### Protocol gap

A formal audit model would need to:

- Define what events constitute an auditable action (message received, Claude invoked, session created, session cleared, command executed).
- Specify a persistent audit log format with: timestamp, Discord user ID, channel ID, project key, session ID, action type, and outcome.
- Define retention requirements for audit records.
- Address attribution for commands (`!kill`, `!restart`) — currently there is no record of which Discord user issued a destructive command.
- Define whether Claude's responses should be logged (they may contain sensitive output from the project directory).
- Specify audit log access controls — the audit log itself would contain sensitive information.

---

## 7. Trust Boundaries

### Current behavior

The trust model is defined in INTENTS.md and reflected in the code as follows:

**I-001: Permission boundary via CLI flags.** The gateway's only mechanism for restricting Claude's capabilities is the `--permission-mode acceptEdits` flag in `claudeArgs`. As noted in I-001 (`INTENTS.md:22`): "At Risk — enforced via CLI flags, not OS-level sandboxing." The gateway validates that `claudeArgs` is an array (`src/config.ts:47-48`) but does not inspect its contents. An operator can set `claudeArgs: ["--dangerously-skip-permissions", "--output-format", "json"]` in `config.json` and the gateway will pass it through without warning.

**I-003: Operator owns the trust boundary.** The README documents the security model in a dedicated section (README.md:22-34): what Claude can and cannot do by default, and how to tighten or loosen it. The init wizard (`src/init.ts:107`) sets safe defaults. However, there is no runtime enforcement that the operator has read or acknowledged the security model. The trust boundary is defined by documentation and convention, not by code.

**I-004: Thin layer.** The gateway does not transform messages before sending to Claude (`src/discord.ts:224-229`: `message.content` is passed directly as the `prompt` argument). Claude's raw JSON output is parsed by `parseClaudeJsonOutput()` (`src/claude-cli.ts:11-18`) and the `result` field is returned as-is. The gateway does not inject system prompts, modify user messages, or filter responses. This is consistent with I-004 (`INTENTS.md:74-95`) but also means the gateway cannot intercept or block any Claude output.

**I-006: Transparent coupling to Claude CLI.** The gateway depends on three specific Claude CLI flags: `--print`, `--resume`, and `--permission-mode` (documented in I-006 success criteria, `INTENTS.md:131`). These are passed as strings in `claudeArgs` with no version checking. If Claude CLI changes the semantics of any of these flags, the gateway will fail silently or produce incorrect behavior. The health check (`src/health.ts:7-16`) only verifies that `claude --version` exits successfully; it does not verify flag compatibility.

**External trust boundary: Discord.** mpg trusts Discord's authentication entirely. A message arriving via the Discord.js `Events.MessageCreate` event is assumed to be authentic. There is no verification that the Discord webhook or WebSocket connection has not been intercepted or spoofed. The Discord bot token is the root of trust for this boundary.

**External trust boundary: Claude CLI.** mpg trusts Claude CLI's output entirely. The stdout of a Claude process is parsed as JSON and its `result` field is forwarded to Discord. There is no sanitization, content filtering, or output validation beyond JSON parsing. If Claude CLI produces unexpected output (e.g., due to a version change), `parseClaudeJsonOutput()` (`src/claude-cli.ts:11-18`) will throw and the error will be surfaced in Discord as a generic parse error.

### Implicit assumptions

- Discord's authentication and message delivery guarantees are assumed to be sufficient. mpg does not implement any defense against Discord API compromise.
- Claude CLI is assumed to be a trusted binary on the operator's PATH. There is no integrity verification of the `claude` executable.
- The operator is assumed to understand and accept the implications of all entries in `claudeArgs` before deploying the gateway.
- The thin-layer principle (I-004) is assumed to be self-enforcing through convention. There is no automated test that verifies the gateway does not inject content into prompts.

### Protocol gap

A formal trust boundary model would need to:

- Define a trust hierarchy: which components are trusted, to what degree, and under what conditions.
- Specify the interface contract between mpg and Claude CLI explicitly — which flags are required, which are optional, and what output schema is expected — so that Claude CLI version changes can be detected at startup rather than at runtime.
- Define what "operator owns the trust boundary" means in operational terms: which configuration values require explicit opt-in vs. which are safe by default, and how the gateway enforces that distinction.
- Address the thin-layer invariant as a testable property: the gateway should be able to assert that a message received equals the message delivered to Claude CLI, with no injected content.
- Define what happens when a trust boundary is violated — e.g., if Claude CLI produces output that fails JSON parsing, what is the correct recovery behavior and what should be logged.
