# HouseholdOS Credential and Permission Protocol — Formalization

**Date:** 2026-03-24
**Source repo:** https://github.com/yama-kei/HouseholdOS

## What this document is

This document formalizes the credential, permission, and trust patterns that HouseholdOS has
implemented in practice into protocol-level descriptions. It is written for readers who are
designing a general-purpose **agent credential and permission broker** — a shared infrastructure
layer that could serve multiple agentic applications the way HouseholdOS's control-plane serves a
single household planning system.

## Why it exists

HouseholdOS is a working system with earned trust properties (see its
[INTENTS.md](https://github.com/yama-kei/HouseholdOS/blob/main/INTENTS.md)). It has arrived at
practical solutions for problems that every multi-tenant agentic system must solve:

- How do you prevent one tenant's data from leaking to another's LLM context?
- How do you ensure an agent can never directly access OAuth tokens?
- How do you make irreversible real-world actions require explicit human approval at the
  architecture level, not just the prompt level?
- How do you give knowledge a lifecycle with governance gates so that high-stakes facts do not
  silently influence scheduling without human acknowledgement?

These solutions exist as concrete code. This document traces each pattern from the TypeScript/SQL
implementation to its formal protocol equivalent and extracts what is generic enough to live in a
shared broker.

---

## 1. Identity Model

### Current behavior

HouseholdOS uses a two-level identity hierarchy: `tenant_id` (the household) and `actor_id` (the
household member). Every database row, audit entry, and tool invocation is scoped to both.

**Channel identity resolution** differs per channel type:

- **LINE** (`apps/api/src/modules/line/webhook.ts:17–21`): Incoming webhooks carry an
  `x-line-signature` header. The server recomputes `HMAC-SHA256(body, channelSecret)` and uses
  `timingSafeEqual` for constant-time comparison. On success, `resolveOrCreateActor(channelRef)`
  looks up or auto-creates the actor record for the LINE user ID within the appropriate tenant.

- **Discord** (`apps/api/src/modules/discord/router.ts:16–22`): A gateway bot calls the API over
  HTTPS. Every request must carry `X-Discord-Secret: <shared-secret>`. The middleware does a
  direct string equality check against the configured secret before any routing occurs.

- **Web dashboard** (`apps/api/src/dashboard/auth.ts:29–55`): Users authenticate via Google
  OAuth. On callback, the server exchanges the code for an access token, calls the Google
  Calendar List API to discover which calendars the user owns, and joins those against
  `calendar_connections` to identify the tenant (`findTenantByCalendars`,
  `apps/api/src/dashboard/auth.ts:110–134`). A session cookie is then set as
  `base64url(payload).HMAC-SHA256(payload)` with a 7-day expiry (`COOKIE_MAX_AGE = 7 * 24 * 60 * 60`,
  `apps/api/src/dashboard/auth.ts:17`).

**Session variables** (`apps/api/src/db/session.ts:10–34`): Every database transaction begins
with `withTenantContext()`, which calls:

```
SELECT set_config('app.tenant_id', $1, true)
SELECT set_config('app.actor_id',  $1, true)
SELECT set_config('app.role',      $1, true)
```

The third parameter `true` makes these settings transaction-scoped: they are automatically cleared
on `COMMIT` or `ROLLBACK`. There is no possibility of session variable bleed between requests,
even on a pooled connection.

PostgreSQL helper functions wrap these settings for use in RLS policies
(`db/migrations/011_rls_helper_functions.sql`):

```sql
create or replace function app_tenant_id() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
```

**JWT validation for API endpoints** (`apps/api/src/middleware/auth.ts:20–53`): Bearer JWTs are
verified with HS256 against `JWT_SECRET`. Validated `tenant_id` and `actor_id` claims are stored
in the Hono context via `c.set()` before any handler executes. Tokens missing either claim are
rejected at line 38–42.

**Channel-tenant binding** (`db/migrations/027_channel_tenants.sql`): The `channel_tenants` table
maps any `channel_ref` (e.g., `line:U123abc`, `discord:123:456`) to a specific `(tenant_id,
actor_id)` pair with a unique constraint on `channel_ref`. This is how `resolveOrCreateActor()`
can map any inbound channel event to the correct household without the user re-authenticating on
every message.

### Formal protocol equivalent

This pattern maps closely to **OAuth 2.0 Token Introspection** (RFC 7662) / **OpenID Connect**
identity federation:

- The LINE HMAC verification is equivalent to **Webhook signature validation** as specified by
  most event provider security guides — functionally a shared-secret MAC scheme where the event
  source proves knowledge of the secret without transmitting it. The `timingSafeEqual` usage
  matches constant-time MAC verification best practice.

- The Discord shared secret is a simplified **API key** scheme — a pre-shared bearer credential
  with no expiry or rotation mechanism. In protocol terms it maps to an opaque API key or a
  static client credential.

- The dashboard Google OAuth flow is a standard **Authorization Code Flow** (RFC 6749 Section 4.1)
  followed by a resource-server lookup (calendarList → tenant join) rather than a traditional
  `sub` claim lookup. The session cookie is a stateless, self-signed **session token** (similar
  to a JWT but using a simpler HMAC-signed base64url format).

- `set_config(..., true)` (transaction-scoped) maps to a **short-lived capability token**
  attached to a single database transaction — semantically equivalent to a scoped bearer token
  with a lifetime of one transaction.

- `app_tenant_id()` in RLS policies maps to the **resource server checking the `aud` claim** of
  a bearer token: the database itself validates the identity attached to the current connection
  before granting row access.

### What's generalizable

1. **Channel-to-principal resolution registry**: The `channel_tenants` table is a general pattern.
   Any agentic broker serving multiple inbound channels (LINE, Discord, Slack, SMS, email) needs
   a durable mapping from `(channel_type, channel_user_id)` to `(tenant_id, actor_id)`. This
   mapping should be managed by the broker, not by each application.

2. **Transaction-scoped identity propagation**: Setting identity claims as transaction-scoped DB
   session variables is a powerful pattern for ensuring that no code path within a transaction
   can accidentally operate outside its authorized tenant boundary. A shared broker could expose
   this as a `withAuthorizedContext(claims, fn)` wrapper.

3. **Per-channel auth strategy abstraction**: The broker could define a `ChannelAuthStrategy`
   interface with implementations for HMAC-webhook, shared-secret, and OAuth-code-flow patterns,
   all normalizing to the same `(tenant_id, actor_id, role)` output.

---

## 2. Credential Model

### Current behavior

HouseholdOS stores Google OAuth tokens encrypted at rest in the `oauth_tokens` table.

**Schema** (`db/migrations/006_create_oauth_tokens.sql:1–21`): The table stores `access_token_enc`
and `refresh_token_enc` as `text` columns. A comment in the schema explicitly documents the
encryption scheme: `-- encrypted at rest: AES-256-GCM, key from env OAUTH_ENCRYPTION_KEY`.

**Encryption format** (`apps/api/src/modules/oauth/service.ts:20–31`): Tokens are encrypted with
AES-256-GCM. The stored format is `iv:authTag:ciphertext` where each component is base64-encoded.
The key is derived from the `OAUTH_ENCRYPTION_KEY` environment variable, which must be a 64-char
hex string (32 bytes). A random 12-byte IV is generated per encryption call.

**Token retrieval** (`apps/api/src/modules/oauth/service.ts:555–620`): `getDecryptedTokens()` is
the only entry point for decrypted tokens. It:

1. Opens a transaction and acquires `SELECT ... FOR UPDATE` on the `oauth_tokens` row
   (pessimistic lock — prevents concurrent refresh races).
2. Decrypts both tokens in memory.
3. If `expires_at` is within 60 seconds of now and a refresh token exists, calls Google's token
   endpoint and stores the new encrypted access token back to the DB — all within the same
   transaction.
4. Returns the plaintext tokens to the caller (the server-side tool executor).

**Opaque to the LLM** (`apps/api/src/modules/chat/tools/index.ts:10`): Tool executors receive a
`ToolContext` containing `tenantId`, `actorId`, `sessionId`, and `timezone` — never any token.
Tools like `search-events.ts` call calendar APIs by retrieving tokens internally via
`getDecryptedTokens()`. The LLM only sees the structured tool result (e.g., a list of calendar
events), never the bearer token.

**Deny-all RLS** (`db/migrations/013_enforce_write_rls.sql:33–36`):

```sql
create policy oauth_tokens_select_none
  on oauth_tokens for select
  to app_client
  using (false);
```

The `app_client` role (used for any read-path or analytics query) can never SELECT from
`oauth_tokens` regardless of what `app.tenant_id` is set to. This is defense-in-depth: even if
application code were compromised and tried to read tokens via `app_client`, the database would
refuse.

**OAuth state parameter** (`apps/api/src/modules/oauth/service.ts:89–105`): The `state` parameter
in the OAuth authorization URL is `base64url(payload).HMAC-SHA256(payload)`. The payload includes
a nonce and a 15-minute expiry (`exp: Math.floor(Date.now() / 1000) + 900`). Verification uses
double-HMAC with a random key (`apps/api/src/modules/oauth/service.ts:126–130`) to achieve
constant-time comparison independent of string length.

### Formal protocol equivalent

- **AES-256-GCM with random IV per encryption** maps to the NIST SP 800-38D authenticated
  encryption standard. The `iv:authTag:ciphertext` format is a compact, self-contained
  authenticated ciphertext envelope — equivalent to what RFC 7516 (JSON Web Encryption, JWE)
  calls a compact serialization, but without the JWE header overhead.

- **Pessimistic `SELECT FOR UPDATE` on token refresh** is the standard database-level mutex
  pattern for avoiding the OAuth token refresh thundering herd problem, equivalent to the
  distributed lock approach described in OAuth 2.0 best practice for refresh token rotation.

- **Token invisibility to the LLM** is a **capability confinement** pattern. The LLM has no
  capability to request tokens directly — it can only invoke named tool functions whose
  implementations are controlled by the server. This is equivalent to the object-capability
  model where an object's authority is defined by the references it holds, and the LLM holds
  no reference to any credential object.

- **Deny-all RLS with `USING (false)`** maps to a **mandatory access control (MAC)** policy:
  regardless of any discretionary grants, the system enforces that `app_client` cannot read
  `oauth_tokens`. This is stronger than RBAC alone.

- The HMAC-signed OAuth `state` parameter implements the **CSRF protection** required by
  OAuth 2.0 (RFC 6749 Section 10.12), using HMAC-SHA256 rather than an opaque random state
  value stored server-side.

### What's generalizable

1. **Credential vault interface**: `getDecryptedTokens(pool, tenantId, actorId)` is already a
   clean vault interface. A shared broker could formalize this as a `CredentialVault` with
   methods `store(tenantId, actorId, provider, tokens)`, `retrieve(tenantId, actorId, provider)`,
   and `revoke(tenantId, actorId, provider)`. Encryption, locking, and refresh would be
   vault-internal.

2. **Tool context token exclusion**: The pattern of passing `ToolContext` that contains identity
   but never credentials is directly portable. Any agentic framework using this broker would
   define tool context to include only `tenantId`, `actorId`, and opaque capability handles —
   never raw tokens.

3. **Deny-all table policy as broker contract**: The `oauth_tokens` deny-all policy for
   `app_client` is a broker-enforced contract: the application data plane can never directly
   access credentials. This boundary could be generalized to any "sensitive column set" in
   a multi-tenant credential store.

---

## 3. Permission Model

### Current behavior

HouseholdOS implements a layered permission model combining PostgreSQL Row-Level Security, two
database roles, and a fixed-capability tool adapter layer.

**Database roles** (`db/migrations/012_apply_rls_policies.sql:1–33`): Two roles are created:

- `app_client`: `nosuperuser`, `noinherit`, `login`. Granted `SELECT` on safe tables only
  (tenants, memory_items, memory_events, actors, tenant_memberships, audit_log,
  calendar_connections, calendar_events_norm). Explicitly excluded: `oauth_tokens`,
  `calendar_events_raw`.
- `app_api`: `nosuperuser`, `nocreatedb`, `nocreaterole`, `inherit`, `login`. Granted `ALL` on
  all tables and sequences. Still subject to RLS (not a superuser, not `BYPASSRLS`).

**RLS on all tenant-scoped tables** (`db/migrations/012_apply_rls_policies.sql:36–95`): Every
table has `ENABLE ROW LEVEL SECURITY`. The SELECT policies all use `USING (tenant_id = app_tenant_id())`,
where `app_tenant_id()` reads the transaction-scoped session variable. This means the DB engine
enforces tenant isolation on every query — there is no way to "forget" to add a `WHERE tenant_id
= ?` clause.

**FORCE ROW LEVEL SECURITY and triggers** (`db/migrations/013_enforce_write_rls.sql:16–183`):
Migration 013 adds `FORCE ROW LEVEL SECURITY` on all tables (ensuring even `app_api` is subject
to RLS) and a trigger function `enforce_tenant_isolation()` that fires on every INSERT/UPDATE/DELETE.
The trigger reads `app.tenant_id` from the session and raises `insufficient_privilege` if the
row's `tenant_id` does not match. This closes the superuser bypass gap: PostgreSQL superusers
bypass RLS policies but not triggers.

**Write RLS policies for `app_api`** (`db/migrations/013_enforce_write_rls.sql:44–112`):
Each tenant-scoped table has explicit INSERT/UPDATE/DELETE policies for `app_api` using
`WITH CHECK (tenant_id = app_tenant_id())`. These are defense-in-depth for future non-superuser
connections.

**Tool-level capability scoping** (`apps/api/src/modules/chat/tools/index.ts:27–36`): The agent
has access to exactly 8 tools: `get_today`, `search_events`, `search_memory`, `list_rules`,
`evaluate_schedule`, `create_pending_event`, `create_pending_rule`, `find_available_slots`. There
is no general-purpose query tool, no file system access, no HTTP client. `getToolExecutor()` at
line 42–44 acts as a capability whitelist: if a tool name is not in `ALL_TOOLS`, it returns
`undefined` and the tool agent logs `Unknown tool: <name>`.

**Governance gate** (`apps/api/src/planning/governance-gate.ts:31–73`): `checkGovernanceGate()`
queries `memory_items` for rows where `governance_state IN ('candidate', 'needs_confirmation')`
and `impact_level = 'high'`. If any such rows exist for the given tenant and participant keys,
the function returns `{ pass: false, blocking_proposals: [...] }`. The evaluate-schedule pipeline
checks this gate before running the constraint engine — a HIGH-impact unconfirmed memory item
blocks schedule evaluation entirely. Feature-flagged via `GOVERNANCE_GATE_ENABLED`.

### Formal protocol equivalent

- **Two DB roles with different grants** maps to **Role-Based Access Control (RBAC)** at the
  database layer. `app_client` is the "read principal" and `app_api` is the "write principal".
  The tenant isolation layer (session variables + RLS) adds an **Attribute-Based Access Control
  (ABAC)** dimension: even `app_api` can only touch rows whose `tenant_id` matches the current
  session attribute.

- **RLS with `USING (tenant_id = app_tenant_id())`** maps to the standard **multi-tenant row
  filtering** pattern described in PostgreSQL documentation and used in systems like Supabase.
  In formal authorization terms it is a **policy enforcement point (PEP)** embedded in the
  storage layer, with the session variable as the **policy information point (PIP)**.

- **`FORCE ROW LEVEL SECURITY` + trigger-based enforcement** is a defense-in-depth pattern that
  achieves **mandatory access control**: no code path, not even one running as a superuser, can
  write a row to a tenant it did not acquire a session context for.

- **Fixed tool capability set** maps to the **principle of least privilege** applied at the agent
  interface boundary. In object-capability terms, the LLM holds a set of unforgeable capability
  references (tool function names) that are statically bounded. It cannot construct new
  capabilities at runtime.

- **Governance gate blocking schedule evaluation** maps to a **policy guard** in a capability
  system: the capability to evaluate a proposed schedule is only usable when the governance
  precondition is satisfied.

### What's generalizable

1. **Tenant-scoped session variable injection as a broker primitive**: The `withTenantContext()`
   wrapper is the single enforcement point that makes all downstream DB operations tenant-safe.
   A broker could expose this as a first-class session establishment API, decoupled from any
   specific DB client.

2. **Tool capability registry**: The `ALL_TOOLS` array and `getToolExecutor()` whitelist is a
   generalizable pattern: a broker-maintained registry of named capabilities, where registration
   requires explicit declaration of scope (which tenant data the tool accesses) and the broker
   refuses to dispatch calls to unregistered capability names.

3. **DB role bifurcation (read principal / write principal)**: The `app_client`/`app_api`
   split is directly reusable. Any multi-tenant system should expose a read-only role that
   cannot access credential tables, and a write role still constrained by tenant isolation.

---

## 4. Confirmation Protocol (Pending Actions)

### Current behavior

HouseholdOS implements an explicit human-in-the-loop confirmation step for all irreversible
external actions via the `pending_actions` table and a stateful confirmation flow.

**Table schema** (`db/migrations/020_pending_actions.sql:3–22`):

```sql
create table pending_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_id uuid not null references actors(id) on delete cascade,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  action_type text not null check (action_type in ('create_event')),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  resolved_at timestamptz
);

create unique index idx_pending_actions_one_per_session on pending_actions (session_id)
  where status = 'pending';
```

The partial unique index `WHERE status = 'pending'` enforces that at most one pending action
can be awaiting confirmation per session at a time.

**Creation flow** (`apps/api/src/modules/chat/pending-actions.ts:16–38`): When the agent calls
`create_pending_event`, `createPendingAction()` first cancels any existing pending action for
the session (idempotent cleanup), then inserts the new row. The tool returns `{ created: true }`
— the LLM sees only a success signal, never the action ID or payload details.

**Tool definition** (`apps/api/src/modules/chat/tools/create-pending-event.ts:9`): The tool
description explicitly instructs the LLM: "ONLY call this AFTER evaluate_schedule returns status
'allowed'." This creates a soft ordering constraint (evaluate before propose) in addition to the
hard architectural constraint (propose before execute).

**Confirmation execution** (`apps/api/src/modules/chat/confirmation-handler.ts`):
`handleConfirmation()` calls `confirmPendingAction()` which does an atomic UPDATE:

```sql
UPDATE pending_actions
SET status = 'confirmed', resolved_at = now()
WHERE id = $1 AND status = 'pending' AND expires_at > now()
RETURNING *
```

The `AND expires_at > now()` clause means TTL enforcement happens atomically at confirmation
time — no separate expiry job is needed for correctness. On success, the handler writes to
both Google Calendar (best-effort, non-blocking) and the local `calendar_events` table, then
appends an audit log entry.

**RLS on pending_actions** (`db/migrations/021_pending_actions_rls.sql`): `app_client` can
SELECT pending actions scoped to their tenant. `app_api` has INSERT/UPDATE/DELETE with tenant
isolation. The same `enforce_tenant_isolation` trigger covers writes.

**Intent** (`INTENTS.md:53–70`): I-003 states: "The AI proposes, humans dispose — this boundary
is architecturally enforced, not prompt-enforced." The `pending_actions` queue is the physical
embodiment of this: there is no code path that allows a calendar write without first passing
through `pending_actions`.

### Formal protocol equivalent

- The `pending_actions` queue maps to a **human-delegated authorization** pattern, analogous to
  the **OAuth 2.0 Device Authorization Grant** (RFC 8628) in structure: an agent requests an
  authorization, the authorization is surfaced to a human out-of-band, and the agent's action
  only executes after the human grants approval. Here the "device" is the agent and the
  "user device" is the chat interface (LINE/Discord/web).

- The 15-minute TTL with atomic expiry enforcement maps to the **authorization code expiry**
  in RFC 6749 Section 4.1.2 — a short-lived code that must be exchanged before it expires,
  ensuring stale proposals do not linger.

- The partial unique index on `(session_id) WHERE status = 'pending'` maps to a
  **one-in-flight authorization per session** constraint — equivalent to single-use authorization
  codes in OAuth.

- The `{ pass: false }` / `{ pass: true }` gate result maps to a **permit/deny authorization
  decision** in XACML terms, with `blocking_proposals` as the obligation attached to a Deny
  decision.

### What's generalizable

1. **Pending action as a broker primitive**: The `pending_actions` table and its TTL/confirmation
   semantics are directly portable to a shared broker. Any agentic application needing human
   confirmation before side effects can delegate to a broker-managed `PendingAction` resource
   with standardized states: `pending → confirmed | cancelled | expired`.

2. **Atomic TTL enforcement at confirmation time**: The `AND expires_at > now()` in the UPDATE
   is a zero-overhead TTL pattern — no background job, no race condition. This pattern should
   be replicated in any broker implementation rather than relying on periodic cleanup.

3. **One-pending-per-session constraint**: The partial unique index preventing multiple
   simultaneous pending proposals per session avoids confirmation confusion ("which of the two
   proposals am I confirming?"). A broker could enforce this as a session-level invariant.

4. **Payload opacity to the LLM**: The agent creates a pending action and receives only
   `{ created: true }`. All payload details live in the DB. The broker pattern is: the LLM
   proposes by name + parameters; the broker stores; the human sees a rendered proposal; the
   LLM is only notified of success/failure of execution after the human acts.

---

## 5. Memory Governance (Permission over Knowledge)

### Current behavior

HouseholdOS treats household knowledge (memory items) as having a lifecycle that governs when
information is trusted enough to influence agent decisions.

**7-state lifecycle** (`apps/api/src/modules/memory/governance-types.ts:1–21`):

```
candidate → needs_confirmation → confirmed → superseded
                              ↘ rejected   ↗ revoked
         ↘ confirmed (direct)
         ↘ rejected
         ↘ expired
```

The `ALLOWED_TRANSITIONS` map encodes which transitions are valid. A `candidate` item can move
to `needs_confirmation`, `confirmed`, `rejected`, or `expired`. Once `confirmed`, it can only
be `superseded` or `revoked`. Terminal states (`rejected`, `superseded`, `expired`, `revoked`)
have no outgoing transitions.

**Status mapping** (`apps/api/src/modules/memory/governance-types.ts:23–31`): Governance states
map to storage `status` values: `candidate`/`needs_confirmation`/`rejected`/`expired` → `'draft'`;
`confirmed` → `'active'`; `superseded` → `'overridden'`; `revoked` → `'disabled'`.

**DB-level constraints** (`db/migrations/017_memory_governance.sql:13–29`): The schema enforces
the governance state and impact level values via CHECK constraints, and adds a critical invariant:

```sql
alter table memory_items
  add constraint memory_items_active_requires_confirmed
  check (not (status = 'active' and governance_state <> 'confirmed'));
```

This means an active (operationally effective) memory item must have been through the governance
confirmation process — the constraint cannot be bypassed at the application layer.

**Transition validation** (`apps/api/src/modules/memory/governance-types.ts:33–41`):
`assertValidTransition(from, to)` throws an error with a descriptive message if the transition
is not in `ALLOWED_TRANSITIONS[from]`. This is called in the memory service before any DB update.

**Concurrency** (`apps/api/src/planning/governance-gate.ts:44–56`): The governance gate query
uses the partial index `idx_memory_unresolved_high` (created in migration 017, line 32–35):

```sql
create index if not exists idx_memory_unresolved_high
  on memory_items (tenant_id)
  where governance_state in ('candidate', 'needs_confirmation')
    and impact_level = 'high';
```

This makes the gate check an index scan, not a full table scan. Individual memory service
operations use `SELECT FOR UPDATE` during governance transitions to prevent concurrent state
changes.

**Impact levels** (`apps/api/src/modules/memory/governance-types.ts:12`): `'low' | 'medium' | 'high'`.
Only `high`-impact unresolved items block the governance gate. Low and medium items can be used
immediately.

**Feature flag**: The governance gate is checked conditionally on `GOVERNANCE_GATE_ENABLED`
environment variable, allowing progressive rollout.

### Formal protocol equivalent

- The 7-state governance lifecycle maps to a **finite state machine (FSM)** with typed transition
  guards — equivalent to a **capability lifecycle** in object-capability systems, where a
  capability can be in states: proposed, delegated for review, authorized, superseded, or revoked.

- `assertValidTransition()` is the FSM's **transition guard function** — equivalent to the
  `validate()` step in event sourcing before applying a state-changing event.

- The `memory_items_active_requires_confirmed` CHECK constraint maps to an
  **integrity invariant** in formal specification: ∀m ∈ memory_items: m.status = 'active' →
  m.governance_state = 'confirmed'. This is expressed at the storage layer and cannot be
  violated by application code.

- **Impact levels as authorization tiers** maps to a simple **sensitivity classification**
  scheme (low/medium/high) where higher sensitivity requires more explicit authorization steps
  before the knowledge becomes operationally effective.

- The governance gate pattern maps to a **precondition check** in a capability protocol:
  before the agent can exercise the "evaluate schedule" capability, it must pass a gate that
  checks for unresolved high-impact capabilities (knowledge items) that the human has not yet
  acknowledged.

### What's generalizable

1. **Knowledge item lifecycle as a broker primitive**: The governance FSM is independently
   useful as a pattern for any system where AI-inferred facts must go through human review
   before influencing agent behavior. A broker could expose a `KnowledgeItem` resource with
   standardized `propose()`, `confirm()`, `reject()`, `revoke()` operations.

2. **Governance gate as an authorization precondition**: The `checkGovernanceGate()` call
   before constraint evaluation is a pattern for blocking downstream capabilities until
   upstream governance is resolved. A broker could expose this as a composable precondition:
   `requireGovernanceCleared(tenantId, participantKeys)` that other capability checks can
   depend on.

3. **DB-level FSM constraint**: The `active_requires_confirmed` CHECK constraint is a strong
   pattern for any state machine whose terminal "effective" state requires explicit
   authorization. Expressing this at the DB level prevents application-layer bugs from
   silently bypassing the governance process.

4. **Partial index for gate queries**: The `idx_memory_unresolved_high` partial index is a
   practical performance pattern for governance gate queries in multi-tenant systems. A broker
   providing governance gate checks should maintain equivalent partial indexes.

---

## 6. Audit Trail

### Current behavior

HouseholdOS maintains an append-only audit log for all mutations to household state.

**Schema** (`db/migrations/007_create_audit_log.sql:1–23`):

```sql
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_id uuid references actors(id) on delete set null,
  event_type text not null,
  resource_type text,
  resource_id uuid,
  payload jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_tenant
  on audit_log (tenant_id, created_at desc);
```

No `updated_at` column, no soft-delete column — the table has only `created_at`. There is no
UPDATE path for audit rows.

**Write interface** (`apps/api/src/modules/audit/service.ts:27–42`): `appendAuditLog()` only
exposes an `INSERT`. There is no `updateAuditLog()` or `deleteAuditLog()` function in the
service module.

**Event types documented in schema** (migration 007, line 7–13): `session_start`, `memory_create`,
`memory_update`, `memory_override`, `memory_delete`, `oauth_connect`, `oauth_revoke`,
`calendar_sync_start`, `calendar_sync_complete`, `confirmation_shown`, `confirmation_accepted`,
`confirmation_rejected`. Additional types are added by later migrations and application code
(e.g., `agent_turn` in `apps/api/src/modules/chat/tool-agent.ts:135`).

**Tenant-scoped RLS** (`db/migrations/012_apply_rls_policies.sql:78–81`):

```sql
create policy audit_log_select
  on audit_log for select
  using (tenant_id = app_tenant_id());
```

Audit log entries are only visible to the tenant they belong to.

**Append-only enforcement** (`db/migrations/013_enforce_write_rls.sql:86–91`): The write policies
for `app_api` include `audit_log_insert` (with tenant check) and `audit_log_update`/`audit_log_delete`.
While the RLS policies technically allow UPDATE and DELETE for `app_api`, the application service
module exposes no such functions. The enforcement is primarily at the application layer; the
schema could be hardened further with a trigger that rejects UPDATE/DELETE on `audit_log`.

**Temporal query support** (`apps/api/src/modules/audit/service.ts:58–103`): `listAuditLog()`
supports cursor-based pagination ordered by `created_at DESC`, with filtering by `event_type`,
`resource_type`, and time range (`from`/`to`). The composite index `(tenant_id, created_at desc)`
makes these queries efficient.

**Agent turn logging** (`apps/api/src/modules/chat/tool-agent.ts:130–147`): After each LLM
interaction, `logToolUsage()` inserts an `agent_turn` audit event with the list of tools called,
which skills they belong to, and whether a pending action was created. This provides a
machine-readable trace of every agent turn.

### Formal protocol equivalent

- The append-only audit log maps to an **event log** in event sourcing terminology, or an
  **audit trail** as defined in NIST SP 800-92 (Guide to Computer Security Log Management).
  The `event_type` + `resource_type` + `resource_id` + `payload` structure is equivalent to
  the (verb, object-type, object-id, context) tuple that audit frameworks recommend.

- **Tenant-scoped RLS on audit log** ensures **audit log isolation**: tenants cannot see each
  other's audit records. This maps to the multi-tenant audit log requirement in SOC 2 Type II
  where each customer's audit data must not be accessible to other customers.

- **Cursor-based temporal pagination** (`created_at < $cursor`) is the standard pattern for
  efficiently walking large append-only logs without offset-based scan degradation.

- **`agent_turn` events with tool lists and skill mappings** map to **provenance records** in
  the W3C PROV model: each agent decision is attributed to a specific actor (`actor_id`), at a
  specific time, using specific capabilities (tools/skills), producing an observable outcome
  (`pending_created`).

### What's generalizable

1. **Audit log as a broker service**: A shared broker maintaining an audit log for all tenant
   operations — credential access, capability invocations, governance transitions, pending action
   lifecycle — provides cross-cutting observability that individual applications do not need to
   implement themselves.

2. **`(verb, resource_type, resource_id, payload)` as a universal audit event schema**: This
   structure is directly portable. The broker could define a standard `AuditEvent` interface and
   guarantee append-only, tenant-scoped persistence for all registered event types.

3. **Agent turn tracing as a first-class event type**: Logging which tools an agent called,
   in what order, and whether a side-effecting action resulted is an essential debugging and
   compliance primitive for agentic systems. A broker should expose `recordAgentTurn()` as a
   standard operation.

4. **Trigger-based DELETE denial for audit tables**: The current system relies on the application
   layer not exposing a delete function. A broker implementation should add a PostgreSQL trigger
   that raises `insufficient_privilege` on any DELETE to `audit_log`, making the append-only
   property a DB-level guarantee rather than an application convention.

---

## 7. Trust Boundaries (from INTENTS.md)

### Current behavior

HouseholdOS's INTENTS.md defines five system-level intents. Four are directly relevant to the
trust and security model. Their "Current Health" values represent the team's own assessment as
of 2026-03-21.

**I-002: Tenant Data Isolation — Status: Earned**

Goal: "One household must never see, infer, or be affected by another household's data — at every
layer."

Mechanisms in place:
- RLS on every tenant-scoped table (`db/migrations/012_apply_rls_policies.sql`)
- FORCE RLS + trigger-based enforcement covering the superuser bypass gap
  (`db/migrations/013_enforce_write_rls.sql:16–183`)
- OAuth tokens encrypted and inaccessible via `app_client` (deny-all policy)
- Session variables transaction-scoped — cannot bleed across requests (`db/session.ts:20–24`)

Risk signals monitored: new tables without RLS, mixed tenant data in LLM prompts, shared
in-memory state across tenant contexts.

**I-003: Human Confirmation Before External Action — Status: Earned**

Goal: "The system must never take an action in the real world without explicit human approval."

Mechanism: `pending_actions` queue. There is no calendar write path that bypasses it.
`createGoogleCalendarEvent()` is called only from `confirmation-handler.ts`, which is only
reachable from the confirmation flow. The distinction "architecturally enforced, not
prompt-enforced" is critical: the agent cannot add instructions to its prompt to skip
confirmation.

**I-004: Deterministic Constraint Evaluation — Status: Earned**

Goal: "Schedule conflict detection must be deterministic and inspectable — never probabilistic
or LLM-dependent."

Mechanism: `evaluateScheduleProposal()` (`apps/api/src/planning/constraint-engine.ts:448–719`)
is a pure function. The function signature takes `EvaluationInput` and returns `EvaluationResult`
with no database calls and no external I/O. The comment at line 1–10 of the file documents the
guarantees explicitly: "Pure logic. No DB access. No LLM. No side effects."

The `EvaluationMeta` struct (`constraint-engine.ts:181–184`) captures `version`, `evaluation_timestamp`,
and `input_hash` (SHA-256 of the normalized input). The input_hash enables replay: re-running
`evaluateScheduleProposal` with the archived input must produce the same hash and result.

**I-005: Immutable Audit Trail — Status: Earned**

Goal: "Every mutation to household state must be recorded in an append-only trail that no actor
can alter after the fact."

Mechanism: `appendAuditLog()` exposes only INSERT. The `audit_log` table has no `updated_at`
column. Soft-deletes are used for memory items (`status = 'disabled'`) so deleted items remain
queryable in the audit.

### Formal protocol equivalent

These four intents map to well-known security and protocol principles:

- **I-002 (Tenant Isolation)**: Maps to the **multi-tenancy isolation requirement** in cloud
  security frameworks (CSA Cloud Controls Matrix CCM-DSP-07, ISO 27001 A.9). The combination
  of RLS + triggers + encrypted credentials implements defense-in-depth isolation at three
  independent layers (query filter, write guard, cryptographic barrier).

- **I-003 (Human Confirmation)**: Maps to the **human-in-the-loop (HITL)** requirement in
  emerging AI governance frameworks (EU AI Act Article 14 on human oversight, NIST AI RMF
  Govern 1.7). HouseholdOS satisfies this not through policy or documentation but through
  an architectural constraint: the code path from "agent decision" to "real-world effect" always
  passes through a human-confirmed pending action.

- **I-004 (Deterministic Constraint Evaluation)**: Maps to the **verifiability** requirement
  in formal specification (a function is verifiable if it is deterministic, side-effect-free,
  and its output can be reproduced from archived inputs). The `input_hash` + `version` +
  `evaluation_timestamp` in `EvaluationMeta` are the minimum fields needed to support
  post-hoc audit replay.

- **I-005 (Immutable Audit Trail)**: Maps to the **non-repudiation** security property
  (ISO 27001 A.12.4) and the append-only log requirement in PCI DSS Requirement 10. The
  combination of application-layer INSERT-only exposure and schema design (no `updated_at`,
  no delete function) achieves this with current infrastructure.

### What's generalizable

1. **Trust boundary declarations as machine-readable artifacts**: INTENTS.md currently exists
   as a human-readable document. A broker could formalize trust boundaries as structured metadata
   (`trust_boundary_id`, `enforcement_mechanism`, `health_status`, `last_verified`) that
   automated tooling can verify against the actual system state (e.g., check that every table
   has RLS enabled, that no new calendar write path bypasses `pending_actions`).

2. **Control plane / data plane separation as a broker architecture pattern**: The core insight
   of HouseholdOS is that authority (tokens, policy, memory governance) lives in the control
   plane, and the LLM reasons exclusively in the data plane using only what the control plane
   surfaces to it. A general broker formalizes this separation: the broker is the control plane;
   applications register their data-plane tools and let the broker enforce the authority
   boundary.

3. **Deterministic evaluation with replay-capable audit records**: The `EvaluationMeta` pattern
   (input_hash + version + timestamp) should be a standard output of any broker-mediated
   decision. It makes every automated decision auditable and disputable: given the archived
   input, any party can rerun the evaluation and verify the result.

4. **Intent health tracking as a living contract**: The `Current Health: Earned / At Risk`
   status in INTENTS.md is a lightweight form of **continuous compliance monitoring**. A broker
   could surface equivalent health signals as an API endpoint, enabling tenant operators to
   query the current enforcement status of each trust boundary (e.g., "are all tables in this
   tenant's schema covered by RLS?").
