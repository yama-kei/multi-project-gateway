# Intent Registry (Draft)

## I-001: Enforced Permission Boundary

Goal:
The gateway must enforce that each Claude session is sandboxed to its project directory with the least privilege necessary. The user must never be surprised by what Claude can access.

Why this exists:
Discord channel membership directly grants access to a Claude session on the operator's machine. A misconfigured or permissive default could expose the entire filesystem, credentials, or shell access to anyone in a mapped channel.

Success Criteria:
- Default `claudeArgs` use `--permission-mode acceptEdits`, never `--dangerously-skip-permissions`
- Claude sessions cannot access files outside their configured project directory
- Dangerous permission overrides require explicit operator action in `config.json`

Risk Signals:
- A code change introduces `--dangerously-skip-permissions` as a default
- A new feature bypasses or weakens the permission mode without operator opt-in
- Claude CLI changes that silently widen the sandbox scope

Initial Health:
🟡 At Risk — enforced via CLI flags, not OS-level sandboxing (see #12)

---

## I-002: Session State Is a First-Class Citizen

Goal:
Session continuity must be preserved across gateway restarts, idle cleanup, and crashes. A session that existed before a restart must be resumable after.

Why this exists:
Sessions carry conversation context that is expensive to rebuild. Losing session state silently degrades the user experience and makes debugging impossible.

Success Criteria:
- Session IDs are persisted to disk before being used
- Gateway restart resumes existing sessions without user intervention
- Idle cleanup removes sessions from memory but preserves their resume capability
- `!session <name>` always reports the correct session ID for terminal resume

Risk Signals:
- Session store writes are deferred or buffered (crash loses state)
- A code path creates a session without persisting it
- Claude CLI changes break `--resume` behavior

Initial Health:
🟡 At Risk — persistence is implemented but not validated under crash scenarios

---

## I-003: Operator Owns the Trust Boundary

Goal:
The person who deploys the gateway is solely responsible for what is exposed. The gateway must make the security implications of every configuration choice unmistakably clear.

Why this exists:
The gateway bridges a chat platform (Discord) to local machine access. The operator — not the gateway — decides who can reach Claude and what Claude can do. If the operator doesn't understand what they're exposing, the system has failed.

Success Criteria:
- README and `mpg init` explain the security model before the gateway starts
- Default configuration is safe without requiring the operator to read docs
- Per-project `claudeArgs` overrides are visible and auditable in `config.json`
- No silent escalation of permissions across updates

Risk Signals:
- A new feature adds capabilities that are enabled by default without operator awareness
- Setup wizard skips security explanation to reduce friction
- Config schema changes that silently alter permission semantics

Initial Health:
🟡 At Risk — defaults are safe, but init wizard security messaging could be stronger

---

## I-004: Thin Layer, Diagnosable by Design

Goal:
The gateway must remain a thin routing layer between Discord and Claude CLI. Any problem on the Claude side must be diagnosable by resuming the Claude session directly.

Why this exists:
If the gateway transforms, filters, or interprets Claude's output, debugging requires understanding the gateway's behavior on top of Claude's. By staying thin, the operator can always `claude --resume <id>` to see exactly what Claude saw and said.

Success Criteria:
- Messages are forwarded to Claude without transformation beyond chunking
- Claude's raw JSON output is the source of truth for responses
- `claude --resume <session-id>` reproduces the full conversation as seen through Discord
- Gateway does not inject system prompts, modify user messages, or filter responses

Risk Signals:
- A feature adds message preprocessing or response filtering
- Gateway begins maintaining conversation state separate from Claude's session
- A middleware layer is introduced between the user message and `claude --print`

Initial Health:
🟡 At Risk — currently thin, but no automated check prevents drift

---

## I-005: Safe and Minimal Setup

Goal:
A new user must be able to install and configure the gateway with the fewest possible manual steps, and the setup process must warn about obvious security risks before the gateway starts.

Why this exists:
A complex setup process leads to misconfiguration. An unclear setup process leads to insecure defaults being accepted without understanding. Both outcomes undermine trust.

Success Criteria:
- `npm install -g multi-project-gateway && mpg init` is sufficient to get started
- Init wizard validates prerequisites (Claude CLI, Discord token) before writing config
- Security model is explained during setup, not buried in docs
- `config.json` is never shipped or committed with real credentials

Risk Signals:
- Setup requires editing files by hand for basic operation
- New required configuration is added without updating the init wizard
- Security warnings are removed to reduce terminal noise

Initial Health:
🟡 At Risk — init wizard exists but security messaging during setup is minimal

---

## I-006: Transparent Coupling to Claude CLI

Goal:
The gateway must be transparent about its dependency on Claude CLI and acknowledge that Claude-side breaking changes may require gateway updates.

Why this exists:
The gateway's value depends entirely on Claude CLI's behavior. Claude CLI is an external dependency that evolves independently. Users must understand that the gateway is a thin adapter, not an abstraction that hides Claude's evolution.

Success Criteria:
- README documents which Claude CLI features the gateway depends on (`--print`, `--resume`, `--permission-mode`)
- Breaking changes in Claude CLI are surfaced as gateway issues, not silently swallowed
- Gateway does not attempt to abstract away Claude CLI's interface
- Version compatibility notes are maintained when Claude CLI changes

Risk Signals:
- Gateway wraps Claude CLI behavior in a way that masks upstream changes
- A Claude CLI update breaks the gateway with no clear error message
- Users believe the gateway guarantees a stable interface independent of Claude CLI

Initial Health:
🟡 At Risk — dependency is implicit; no explicit compatibility documentation exists

---

## Signals

Recorded under `intentlayer/signals/`.

## Audits

Recorded under `intentlayer/audits/`.
