# Gap Analysis: mpg vs. HouseholdOS Credential and Permission Models

**Date:** 2026-03-24
**Status:** Exploratory
**Inputs:** [mpg-protocol.md](./mpg-protocol.md), [householdos-protocol.md](./householdos-protocol.md)

## Context and Purpose

This document compares the credential and permission models of two working systems:

- **mpg** (multi-project-gateway): A Discord-to-Claude CLI routing layer. It is a thin layer that maps Discord channels to project directories and spawns Claude CLI processes. Its security model is implicit and operator-dependent, relying on CLI flags, filesystem boundaries, and Discord channel membership.

- **HouseholdOS**: A multi-tenant household planning system with an LLM agent. It has an explicit, layered security model with encrypted credential storage, Row-Level Security, a pending actions confirmation queue, a 7-state memory governance FSM, and an append-only audit trail.

The purpose is to identify what an **agent credential and permission broker** must provide to serve both systems (and others like them) as shared infrastructure. The broker sits between agent code and protected resources, mediating all credential access, permission checks, and human-in-the-loop confirmations.

---

## 1. Comparison Matrix

| Capability | mpg | HouseholdOS | Gap |
|---|---|---|---|
| **Identity** | None. All Discord users treated identically; only `author.bot` is checked (`src/discord.ts:169`). No `userId` in `PersistedSession`. | Two-level hierarchy: `tenant_id` + `actor_id`. Channel-to-principal resolution via `channel_tenants` table. Transaction-scoped session variables (`withTenantContext()`). | mpg needs per-user identity. Discord snowflake IDs are available but unused. |
| **Credential storage** | Plaintext `.env` for Discord bot token (`src/init.ts:37`). Claude API key managed entirely by Claude CLI (`~/.claude`). No encryption, no credential database. | AES-256-GCM encrypted `oauth_tokens` table (`iv:authTag:ciphertext` format). Key from `OAUTH_ENCRYPTION_KEY` env var. Pessimistic locking (`SELECT FOR UPDATE`) on token retrieval. | mpg has no credential management at all. HouseholdOS has a production-grade credential vault. |
| **Credential isolation from agent** | Not isolated. Claude CLI processes run as the same OS user and share `~/.claude`. The agent has filesystem access to `.env` and session files. | Fully isolated. LLM receives `ToolContext` with `tenantId`/`actorId` only, never tokens. Tools call `getDecryptedTokens()` server-side. Deny-all RLS policy on `oauth_tokens` for `app_client`. | mpg agents can theoretically access all host credentials. HouseholdOS achieves capability confinement. |
| **Permission scoping** | CLI flags only: `--permission-mode acceptEdits` and `cwd` boundary. Both enforced by Claude CLI, not mpg. `claudeArgs` passed through without validation (`src/config.ts:47-48`). Operator can set `--dangerously-skip-permissions` without warning. | Three layers: (1) DB roles (`app_client` read-only, `app_api` write with RLS), (2) fixed 8-tool capability whitelist (`getToolExecutor()`), (3) governance gate blocking schedule evaluation for unresolved high-impact items. `FORCE ROW LEVEL SECURITY` + triggers close the superuser bypass gap. | mpg is coarse-grained and externally enforced. HouseholdOS is fine-grained with defense-in-depth at DB, application, and governance layers. |
| **Human-in-the-loop** | None from mpg itself. `acceptEdits` mode delegates edit approval to Claude CLI's internal prompt. No pending action queue, no confirmation flow. | `pending_actions` table with 4-state FSM (`pending -> confirmed | cancelled | expired`). 15-minute TTL with atomic expiry. One pending action per session (partial unique index). Architecturally enforced: no calendar write path bypasses it. | mpg has no confirmation mechanism. HouseholdOS has a production confirmation protocol that could generalize. |
| **Delegation chains** | None. Single hop: Discord user -> mpg -> Claude CLI. No mechanism for one agent to delegate to another with narrowed scope. | None. Single hop: user -> tool agent. Tools are statically defined; the agent cannot spawn sub-agents or delegate capabilities. | Neither supports multi-hop delegation. This is a shared gap. |
| **Credential rotation** | None. Discord bot token is static in `.env`. Claude API key rotation is external to mpg. No hot-reload mechanism; rotation requires gateway restart. | Automatic OAuth access token refresh with pessimistic locking (`getDecryptedTokens()` checks `expires_at` within 60 seconds and refreshes within the same transaction). Refresh tokens themselves have no rotation mechanism. | mpg has no rotation at all. HouseholdOS handles access token refresh but not refresh token rotation. |
| **Revocation** | Kill session via `!kill` command (`src/discord.ts`). This removes the session from memory and cleans up the worktree. No credential revocation path; compromised tokens require manual `.env` edit and restart. | Governance state machine allows `confirmed -> revoked` transitions. OAuth tokens can be revoked via `CredentialVault.revoke()` pattern. No cascade revocation (revoking a tenant does not cascade to revoke all associated tokens in a single operation). | Neither has cascade revocation. mpg has no revocation at all beyond session kill. |
| **Audit trail** | Console logs only (`src/cli.ts:91`, `src/discord.ts:254`). No per-message logging. No user identity in session records. `lastActivity` is a timestamp only. Session IDs exposed via `!session` commands. | Append-only `audit_log` table with 20+ event types. Structured as `(event_type, resource_type, resource_id, payload)`. Tenant-scoped via RLS. `agent_turn` events log tool invocations with skill mappings. Cursor-based temporal pagination. | mpg has no persistent audit. HouseholdOS has a comprehensive audit system that could serve as the broker's audit model. |
| **Session isolation** | Worktree isolation (filesystem-level git worktrees for thread sessions). Process isolation (separate OS processes). All processes share OS user and `~/.claude`. No container or namespace isolation (I-001 "At Risk"). | Tenant isolation via database: transaction-scoped session variables, RLS on every table, `FORCE ROW LEVEL SECURITY`. No shared in-memory state across tenant contexts. | Different isolation domains (filesystem vs. database). Both are effective for their contexts but neither provides cross-system isolation. |
| **Consent UX** | None. No mechanism for mpg to ask a Discord user for approval before an action. | Chat-based confirmation: agent proposes via `create_pending_event`, user confirms in the same chat session. Rendered proposal shown to human; agent sees only success/failure. | Both could use a channel-native consent protocol (Discord reactions/buttons, LINE quick replies). HouseholdOS's chat-based flow is closest to this but is not channel-abstracted. |

---

## 2. Gaps Neither System Addresses

### 2.1 Delegation chains with scope narrowing

Neither system supports Agent A delegating a subset of its capabilities to Agent B with automatically narrowed scope.

**Why this matters:** In multi-agent architectures, a coordinator agent may need to dispatch sub-tasks to specialist agents (e.g., a planning agent delegating calendar lookup to a calendar agent). Without formal delegation chains, either every agent gets the same broad permissions (violating least privilege) or delegation is impossible (limiting composability). The broker must support at least 2-hop delegation where each hop can only narrow, never widen, the permission scope. For example: user grants `read+write` to Agent A, which delegates only `read` to Agent B. If Agent B attempts `write`, the broker rejects it even though Agent A could have performed the write itself.

### 2.2 Capability tokens

Neither system uses formal capability tokens. mpg uses CLI flags (`--permission-mode`, `--allowed-tools`) as opaque strings. HouseholdOS uses PostgreSQL session variables (`set_config('app.tenant_id', ...)`) that are transaction-scoped but not cryptographically bound.

**Why this matters:** CLI flags and session variables are effective within a single runtime but cannot cross process or network boundaries. A multi-agent system needs capability tokens that can be issued, passed between agents, validated by the broker, and expired. Without them, every agent must authenticate independently with the broker, and there is no way to prove that Agent B's request was authorized by Agent A. Capability tokens also enable offline validation: a receiving agent can verify a token's scope and validity without calling back to the issuer.

### 2.3 Cascade revocation

Neither system can revoke a parent authorization and automatically cascade that revocation to all derived authorizations. mpg's `!kill` destroys a session but has no concept of child sessions. HouseholdOS's governance FSM supports `confirmed -> revoked` for individual memory items but does not cascade across related items or derived actions.

**Why this matters:** In delegation chains, revoking a user's access must immediately invalidate all capabilities the user delegated to agents, and all sub-delegations those agents made. Without cascade revocation, revoked principals may retain effective access through cached or delegated tokens. This is especially critical for incident response: when a credential is compromised, the operator needs a single revocation that propagates through the entire delegation tree.

### 2.4 Cross-system credential broker pattern

Neither system implements a universal credential brokering pattern. HouseholdOS's `getDecryptedTokens()` is an excellent credential vault for Google OAuth, but it is application-specific. mpg has no credential management at all.

**Why this matters:** The core broker pattern is: (1) agent requests a named capability (e.g., "read calendar"), (2) broker resolves which credential is needed and retrieves it from the vault, (3) broker executes the API call on the agent's behalf, (4) agent receives only the result, never the credential. This "broker executes on behalf" pattern is what keeps credentials out of agent context entirely. HouseholdOS approximates this (tools call `getDecryptedTokens()` server-side), but the credential resolution and execution are embedded in each tool rather than centralized in a broker.

### 2.5 Unified audit format

HouseholdOS has a rich audit trail with 20+ event types and structured `(event_type, resource_type, resource_id, payload)` records. mpg has no persistent audit at all.

**Why this matters:** A broker serving multiple applications needs a single audit format that can capture events from all of them: credential access, capability invocations, delegation events, governance transitions, consent requests and responses. Without a unified format, correlating events across systems (e.g., "this mpg session used a credential that was rotated by HouseholdOS's refresh mechanism") requires ad-hoc log parsing. The format must support attribution chains: who requested what, on whose behalf, through which delegation path.

### 2.6 Channel-native consent protocol

Neither system has an abstracted, channel-native consent protocol. HouseholdOS has chat-based confirmation (text messages proposing an action, user typing "yes"/"no"), but it is tied to the LINE/Discord chat interface without a formal protocol layer. mpg has no consent mechanism at all.

**Why this matters:** Consent must happen where the user is. On Discord, this means reactions or button components. On LINE, quick reply buttons. On web, form submissions. The broker needs a consent request/response protocol that is channel-agnostic at the protocol level but renders natively on each channel. This is especially important because consent latency affects user experience: a Discord reaction is sub-second; typing a confirmation message is multi-second. The protocol should also handle consent timeouts (HouseholdOS's 15-minute TTL is a good starting point) and consent for absent users (escalation to another authorized actor).

### 2.7 Agent identity

Neither system has cryptographic agent identity. mpg identifies agents implicitly (a Claude CLI process spawned by the gateway). HouseholdOS identifies agents by their tool context (`tenantId`, `actorId`) but does not distinguish between different agent instances or verify that a tool invocation actually came from the authorized agent process.

**Why this matters:** In multi-agent systems, the broker must verify that a capability request comes from the specific agent instance that was granted the capability. Without cryptographic agent identity (e.g., a signed agent checksum as proposed in the Agentic JWT draft), any process that can construct a valid-looking request can impersonate an agent. This is particularly relevant for mpg, where all Claude CLI processes share the same OS user and could theoretically access each other's session files.

---

## 3. Standards Landscape Mapping

| Gap | Most Relevant Standard | Maturity | Notes |
|---|---|---|---|
| **Delegation chains** | **Grantex** (depth limits + scope narrowing) | Early (Apache 2.0 protocol spec) | Provides: formal model for multi-hop delegation with monotonic scope narrowing, explicit depth limits, and typed permission grants. Does not provide: implementation libraries, integration with existing auth frameworks, or performance benchmarks for deep chains. |
| **Capability tokens** | **Agentic JWT** (draft-goswami-agentic-jwt-00) | IETF draft | Provides: JWT extension with `agent_id`, `agent_checksum`, `delegator` claims and scope narrowing semantics. Compatible with existing JWT libraries. Does not provide: key management for agent checksums, token size limits for constrained environments, or migration path from existing JWT-based systems. |
| **Cascade revocation** | **Grantex** (granular revocation with cascade) | Early | Provides: revocation of a grant with automatic cascade to all derived grants. Revocation propagation model. Does not provide: real-time revocation (relies on polling or token expiry), guaranteed delivery of revocation events, or integration with OAuth token revocation (RFC 7009). |
| **Credential broker** | **Arcade.dev** / **MCP Authorization** (2025-03-26 spec) | Production (Arcade) / Spec (MCP) | Arcade provides: production credential brokering with "execute on behalf" pattern, pre-built integrations for 100+ services. MCP Authorization provides: OAuth 2.1-based auth framework for MCP servers with dynamic client registration. Neither provides: a unified standard across both approaches, or offline-capable credential resolution. |
| **Audit format** | **Transaction Tokens for Agents** (Txn-Token, IETF draft) | IETF draft | Provides: standardized token format for recording multi-hop transaction context across services. Compatible with OpenTelemetry trace context. Does not provide: storage format for audit logs, retention policies, or query interfaces. Would need to be combined with a storage layer like HouseholdOS's `audit_log` schema. |
| **Consent protocol** | **Arcade.dev URL Elicitation** / **MCP Elicitation** (accepted SEP) | Production (Arcade) / MCP SEP (accepted) | Arcade provides: URL-based consent flow where the broker redirects users to an authorization page. MCP Elicitation provides: a protocol for servers to request additional information from users during tool execution. Neither provides: channel-native rendering (both assume web browser), timeout semantics, or absent-user escalation. |
| **Agent identity** | **Agentic JWT** (`agent_checksum` claim) | IETF draft | Provides: a mechanism to bind a JWT to a specific agent binary/configuration via SHA-256 checksum. Enables the broker to verify that the requesting agent matches the one that was authorized. Does not provide: runtime integrity monitoring (checksum is static at issuance time), revocation of compromised agent binaries, or a standard for computing checksums of LLM-based agents whose behavior changes with prompt. |

---

## 4. Broker Requirements for Phase 2

### P0 (Must have)

**Opaque credential handles.** Agents must never see raw tokens (OAuth access tokens, API keys, bot tokens). The broker issues opaque handles that agents pass back to the broker when requesting an action. The broker resolves the handle to the actual credential internally.
- *Builds on:* HouseholdOS's `ToolContext` pattern (identity without credentials) and `getDecryptedTokens()` (server-side token retrieval). mpg has no equivalent; this is net-new for mpg.

**Per-session permission scoping.** Each agent session must declare which tools, APIs, and resource scopes it is allowed to use. The broker validates every capability invocation against the session's declared scope.
- *Builds on:* HouseholdOS's `ALL_TOOLS` whitelist and `getToolExecutor()` capability registry. mpg's `claudeArgs` with `--permission-mode` and `--allowed-tools` provides the concept but not the enforcement; the broker would validate rather than pass through.

**Channel-native consent.** The broker must support consent requests that render natively on each channel: Discord buttons/reactions, LINE quick reply actions, web forms. Consent responses flow back to the broker, which unblocks the pending action.
- *Builds on:* HouseholdOS's `pending_actions` queue (state machine, TTL, one-per-session constraint). mpg's Discord.js integration provides the channel interface but has no consent protocol.

**Persistent audit trail with full attribution chain.** Every broker-mediated action must be recorded with: timestamp, principal (tenant + actor), agent identity, capability invoked, resource accessed, outcome, and delegation path (if any).
- *Builds on:* HouseholdOS's `audit_log` table and `(event_type, resource_type, resource_id, payload)` schema. mpg's console logging is insufficient; the broker audit trail replaces it entirely.

**Credential lifecycle (provision, refresh, revoke).** The broker must manage the full lifecycle of credentials: initial storage (encrypted), automatic refresh (for OAuth tokens with expiry), and explicit revocation (removing credentials from the vault and invalidating all active sessions using them).
- *Builds on:* HouseholdOS's AES-256-GCM encryption, pessimistic-lock refresh within transaction, and `CredentialVault` interface pattern. mpg's static `.env` approach is replaced entirely.

### P1 (Should have)

**Delegation chains with scope narrowing (at least 2 hops).** The broker must support user -> Agent A -> Agent B delegation where each hop can only narrow the granted scope. A delegation record links child grants to parent grants.
- *Builds on:* Neither system has delegation. The broker introduces this as a new primitive. HouseholdOS's governance FSM (with its state transitions and validation via `assertValidTransition()`) provides a useful pattern for modeling delegation state.

**Short-lived capability tokens (JWTs with TTL).** The broker issues signed tokens encoding the session's permitted scope, agent identity, and a short TTL (minutes, not hours). Agents present these tokens to resource servers or other agents as proof of authorization.
- *Builds on:* HouseholdOS's transaction-scoped session variables (conceptually similar: short-lived, automatically cleared). The Agentic JWT draft provides the token format.

**Cascade revocation.** Revoking a parent grant must automatically revoke all child grants in the delegation tree. The broker maintains a grant tree and walks it on revocation.
- *Builds on:* Neither system has cascade revocation. HouseholdOS's `ON DELETE CASCADE` foreign keys on `tenant_id` demonstrate the DB-level cascade pattern, which can be extended to grant records.

**Agent identity (checksum or equivalent).** Each agent instance must be identifiable via a verifiable attribute (binary checksum, configuration hash, or signed manifest). The broker records agent identity in audit logs and validates it during capability requests.
- *Builds on:* Neither system has agent identity. mpg's health check (`src/health.ts:7-16`) already runs `claude --version`; this could be extended to capture a version/checksum.

### P2 (Nice to have)

**Cross-organization federation.** Allow tenants from different organizations to share specific capabilities via the broker, with explicit cross-tenant grants and isolated audit trails.
- *Builds on:* HouseholdOS's tenant isolation model (RLS + session variables) provides the foundation; federation adds controlled holes in the isolation boundary.

**Dynamic permission escalation protocol.** Allow an agent to request elevated permissions at runtime (e.g., requesting write access when it only has read). The request flows through the consent protocol to a human who can approve or deny the escalation.
- *Builds on:* HouseholdOS's `pending_actions` pattern (propose-confirm flow). The escalation request is a special type of pending action where the payload is a permission grant rather than an external action.

**MCP server interface for the broker.** Expose the broker as an MCP server, allowing MCP-compatible agents to discover and use brokered capabilities via the standard MCP tool protocol.
- *Builds on:* mpg already integrates with Claude CLI, which supports MCP. The broker would register as an MCP server that Claude CLI can discover.

**Formal wire protocol specification.** Define the broker's API as a versioned wire protocol (not just a library interface) so that non-TypeScript agents can integrate. Include protocol version negotiation and backward compatibility guarantees.
- *Builds on:* HouseholdOS's structured API endpoints and mpg's Claude CLI flag interface both demonstrate the need for explicit interface contracts. mpg's I-006 (transparent coupling to Claude CLI) specifically calls out the risk of unversioned interface dependencies.
