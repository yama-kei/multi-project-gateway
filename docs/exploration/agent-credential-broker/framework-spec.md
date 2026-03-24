# Agent Governance Framework — Design Specification

**Date:** 2026-03-24 | **Status:** Draft | **Phase:** 2 of 3 (Design)

**Inputs:**
- [mpg-protocol.md](mpg-protocol.md) — Phase 1 MPG credential and permission protocol
- [householdos-protocol.md](householdos-protocol.md) — Phase 1 HouseholdOS credential and permission protocol
- [gap-analysis.md](gap-analysis.md) — Phase 1 gap analysis

---

## What this is

A governance framework that answers the question: **when and whether agents should act.** It sits above authentication and authorization as a composable, declarative layer of preconditions — gates — that must pass before an agent exercises a capability. The framework generalizes patterns already present in HouseholdOS (governance gates, pending actions) and MPG into a system that can be adopted by any agent-powered application.

## What this is NOT

- **NOT a credential broker.** Credential plumbing (OAuth token storage, refresh, exchange) is delegated to existing solutions: Nango, Arcade.dev, or MCP Auth. This framework assumes credentials exist and are valid.
- **NOT an auth protocol.** Authentication and authorization (who is this actor, what are they allowed to do) are prerequisites that must be satisfied before governance gates are evaluated.
- **NOT an agent runtime.** This framework does not schedule, dispatch, or execute agents. It provides the gate layer that an agent runtime calls before execution.

## Differentiation table

| Concern | Handled by |
|---|---|
| OAuth tokens | Delegate to Nango / Arcade.dev / MCP Auth |
| Delegation chains | Governance state carried as token claim (Grantex-style) |
| Should agent act now? | **Governance gates (this framework)** |
| Human confirmation | **Confirmation protocol (this framework)** |
| Is knowledge trusted? | **Knowledge governance lifecycle (this framework)** |
| Cross-system audit | **Unified audit trail (this framework)** |

## Relationship to Phase 1 requirements

Phase 1 identified several gaps. The credential-plumbing P0 items (token storage, OAuth flows, cross-system identity) are now explicitly delegated to proven third-party solutions and are out of scope here.

This framework addresses:
- **Gap 2.1** — No unified policy enforcement point across MPG and HouseholdOS
- **Gap 2.5** — HouseholdOS governance gate is not generalized or configurable
- **Gap 2.6** — Pending actions / human confirmation has no shared protocol
- **Gap 2.7** — Knowledge trust lifecycle is implicit and system-specific

It also adds two new contributions not surfaced in Phase 1:
- **Governance gates** as a first-class, composable, declarative primitive
- **Knowledge governance lifecycle** as a named concern with defined states and transitions

## Target audience

**Primary:** Operators running agent systems who need to configure when agents are permitted to act, what human confirmation is required, and how policy rules are enforced across capabilities.

**Secondary:** Developers building agent-powered applications who need a well-defined interface for plugging governance into their agent invocation path.

---

## Section 1: Governance Gates

### 1.1 Gate model

A **gate** is a named precondition that must pass before an agent can exercise a capability.

Key properties:

- Gates are **composable**: a capability can require multiple gates, all of which must pass.
- Gates are **evaluated synchronously** at invocation time. Results are not cached between invocations.
- A gate returns one of two shapes:
  - `{ pass: true }` — the precondition is satisfied; proceed to the next gate or to execution.
  - `{ pass: false, reason: string, blocking: Resource[] }` — the precondition is not satisfied; the `reason` is human-readable, and `blocking` is the set of resources (proposals, pending actions, policy violations) that are preventing passage.

### 1.2 Gate types

Four gate types are defined in v1.

**Knowledge gate**

Blocks if unresolved high-impact knowledge proposals exist within the configured scope. The impact threshold is configurable (e.g., `high`, `medium`, `any`). This is a generalization of HouseholdOS's `checkGovernanceGate()`, which blocks schedule evaluation when unresolved HIGH-impact memory proposals exist.

**Confirmation gate**

Blocks until a human confirms the intended action. When this gate is evaluated, it creates a pending action record and suspends the invocation. The invocation resumes only when the pending action is resolved (approved or rejected) within the configured TTL. This is a generalization of HouseholdOS's `pending_actions` mechanism.

**Policy gate**

Applies declarative rules that do not require human interaction. Rules are expressed as YAML predicates. In v1, only built-in rule types are supported:

- `time_window` — permits or denies based on time-of-day or day-of-week.
- `rate_limit` — enforces a maximum invocation count over a sliding window per `(capability, session_id)`. The counter store is pluggable: in-memory for single-instance deployments, Redis for distributed deployments.
- `require_prefix` — requires that a string argument (e.g., branch name, resource path) matches a required prefix.
- `block_pattern` — rejects if a string argument matches a blocked pattern.

Custom rule types are not supported in v1 to maintain a closed, auditable rule surface.

**Delegation gate**

Blocks if the actor's delegation chain does not include the required capability. Integrates with Grantex-style delegation tokens where the delegation chain is carried as a token claim. This gate validates that the chain, as presented, grants the capability being exercised.

### 1.3 Gate composition

Multiple gates on a capability are AND-composed by default. Evaluation short-circuits on the first failure: if a gate does not pass, subsequent gates are not evaluated and the failure result is returned immediately.

Example: `calendar:write` requires both a knowledge gate and a confirmation gate.

```
calendar:write
  → knowledge_gate(impact=high)   [must pass]
  → confirmation_gate(ttl=15m)    [must pass]
  → execute
```

If unresolved high-impact proposals exist, the knowledge gate fails and the confirmation gate is never evaluated.

### 1.4 Gate registration

Gates are registered per capability in a YAML configuration file.

```yaml
capabilities:
  calendar:write:
    gates:
      - type: knowledge
        impact_threshold: high
        scope: [participant_keys]
      - type: confirmation
        ttl: 15m
        channel: origin
  calendar:read:
    gates: []
  git:push:
    gates:
      - type: confirmation
        ttl: 5m
      - type: policy
        rules:
          - no_push_after: "22:00"
          - require_branch_prefix: "mpg/"
```

A capability with `gates: []` has no governance preconditions. This is explicit: capabilities must be listed to be governed; unlisted capabilities are denied by default in strict mode or permitted in permissive mode (operator-configurable).

### 1.5 Integration with existing auth

Gates run **after** authentication and authorization. They do not replace auth. The flow is:

```
Agent request
     |
     v
+----------+
|   Auth   |  token validation, permission check (existing layer)
+----------+
     |
     v (auth passes)
+----------+
|  Gates   |  governance checks (this framework)
+----------+
     |
     v (all gates pass)
+----------+
| Execute  |  capability is exercised
+----------+
```

If auth fails, the request is rejected before gates are evaluated. Gates never run on unauthenticated or unauthorized requests.

### 1.6 Gate interface

```typescript
interface GateResult {
  pass: boolean;
  reason?: string;
  blocking?: Resource[];
}

interface Gate {
  type: string;
  evaluate(capability: string, context: GovernanceContext): Promise<GateResult>;
}

interface GovernanceContext {
  tenant_id: string;
  actor_id: string;
  session_id: string;
  agent_id?: string;
  delegation_chain?: string[];
}
```

`GovernanceContext` is constructed by the caller (agent runtime or API gateway) from the validated auth token and passed through to every gate in the composition chain. Gates must not mutate the context. The `delegation_chain` field is optional; it is populated only when the actor is operating under a delegated credential.

---

## Section 2: Confirmation Protocol

This generalizes HouseholdOS's `pending_actions` queue into a channel-agnostic confirmation protocol.

### 2.1 Confirmation lifecycle (state machine)

```
pending → confirmed → executed
       → cancelled
       → expired
       → failed (execution failed after confirmation)
```

Allowed transitions:
- `pending → confirmed` — human confirms
- `pending → cancelled` — human cancels or new confirmation auto-cancels existing one
- `pending → expired` — TTL elapsed (enforced atomically at confirmation time via `AND expires_at > now()`)
- `confirmed → executed` — framework executes the action successfully
- `confirmed → failed` — execution fails after confirmation

Terminal states: `executed`, `cancelled`, `expired`, `failed`.

### 2.2 Confirmation request schema

```typescript
interface ConfirmationRequest {
  id: string;
  tenant_id: string;
  session_id: string;
  capability: string;            // e.g., "calendar:write"
  action: {
    type: string;                // e.g., "create_event"
    params: Record<string, unknown>;
    display: {
      title: string;
      description: string;
      details?: Record<string, string>;
    };
  };
  ttl_seconds: number;           // e.g., 900 (15 minutes)
  created_at: string;            // ISO 8601
  expires_at: string;            // ISO 8601
  status: ConfirmationStatus;
  channel: {
    type: 'discord' | 'line' | 'web' | 'origin';
    id?: string;
  };
  resolved_at?: string;
  resolved_by?: string;          // actor_id
}

type ConfirmationStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed' | 'failed';
```

### 2.3 Channel adapters

Each channel implements a `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  renderConfirmation(request: ConfirmationRequest): Promise<void>;
  onResolution(handler: (requestId: string, resolution: 'confirmed' | 'cancelled') => void): void;
  updateStatus(requestId: string, status: ConfirmationStatus): Promise<void>;
}
```

Channel-specific rendering:
- **Discord**: Interactive message with Button components (Confirm / Cancel). Button `custom_id` encodes the confirmation request ID. On timeout, edit message to show "Expired" and remove buttons.
- **LINE**: Flex Message with Quick Reply buttons. Postback action carries the confirmation ID.
- **Web**: Form with structured proposal display and Confirm/Cancel buttons. WebSocket or SSE for real-time status updates.
- **`origin`**: Render in whichever channel originated the agent's request. Resolved at request time by looking up the session's originating channel.

### 2.4 Constraints
- One pending confirmation per session (enforced via partial unique index `WHERE status = 'pending'`).
- Creating a new confirmation auto-cancels any existing pending confirmation for that session.
- TTL enforcement is atomic at confirmation time — no background expiry job needed. The confirmation query includes `AND expires_at > now()`.
- The agent sees only `{ created: true }` when proposing — never the action payload or confirmation ID.

### 2.5 Absent-user handling
- Default: confirmation expires after TTL. Agent is notified that the action was not approved.
- Optional escalation: configurable per capability. If primary actor doesn't respond within `escalation_after` (e.g., 10 minutes), the confirmation is re-rendered to a secondary authorized actor.
- Optional deferred queue: action is saved with status `deferred` for when the user next interacts. Maximum deferred queue depth per session is configurable (default: 1).

### 2.6 Integration point

The confirmation protocol is invoked by the `confirmation` gate type from Section 1. Flow:
1. Gate engine evaluates `confirmation` gate for a capability.
2. Gate creates a `ConfirmationRequest` via the confirmation protocol.
3. Channel adapter renders the confirmation in the user's channel.
4. Gate suspends (returns `{ pass: false, reason: "awaiting_confirmation", blocking: [confirmationRequest] }`).
5. Human confirms → protocol transitions to `confirmed` → gate re-evaluates → passes.
6. Framework executes the action → protocol transitions to `executed`.
7. Audit events emitted at each transition.

---

## Section 3: Knowledge Governance Lifecycle

This generalizes HouseholdOS's memory governance FSM into a framework primitive.

### 3.1 Core concept

In agent systems, knowledge is not just data — it's a governed resource. The agent's authority to act depends on the governance state of the knowledge it uses. This section defines a lifecycle for knowledge items that governs when information is trusted enough to influence agent decisions.

This is NOT a general-purpose knowledge base or RAG system. It is NOT a memory store (that's application-level — HouseholdOS has its own). It IS a governance layer over knowledge that agents rely on for decision-making.

### 3.2 Knowledge item model

```typescript
interface KnowledgeItem {
  id: string;
  tenant_id: string;
  source: {
    type: 'agent_inferred' | 'human_provided' | 'external_import';
    agent_id?: string;
    session_id?: string;
  };
  content: {
    type: string;                // domain-specific (e.g., "schedule_rule", "preference", "fact")
    value: Record<string, unknown>;
    display: string;             // human-readable summary
  };
  impact_level: 'low' | 'medium' | 'high';
  governance_state: GovernanceState;
  created_at: string;
  updated_at: string;
  confirmed_by?: string;
  superseded_by?: string;
}

type GovernanceState =
  | 'candidate'
  | 'needs_confirmation'
  | 'confirmed'
  | 'rejected'
  | 'superseded'
  | 'revoked'
  | 'expired';
```

### 3.3 State transitions

```
candidate → needs_confirmation | confirmed | rejected | expired
needs_confirmation → confirmed | rejected
confirmed → superseded | revoked
rejected → (terminal)
superseded → (terminal)
revoked → (terminal)
expired → (terminal)
```

Transition guards enforced by the framework:

```typescript
const ALLOWED_TRANSITIONS: Record<GovernanceState, GovernanceState[]> = {
  candidate: ['needs_confirmation', 'confirmed', 'rejected', 'expired'],
  needs_confirmation: ['confirmed', 'rejected'],
  confirmed: ['superseded', 'revoked'],
  rejected: [],
  superseded: [],
  revoked: [],
  expired: [],
};

function assertValidTransition(from: GovernanceState, to: GovernanceState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid governance transition: ${from} → ${to}`);
  }
}
```

DB-level integrity invariant (must be enforced regardless of application code):
```sql
CHECK (NOT (status = 'active' AND governance_state <> 'confirmed'))
```
This ensures an operationally effective knowledge item must have been through the governance confirmation process.

### 3.4 Impact levels and governance gates

| Level | Behavior | Gate interaction |
|---|---|---|
| `low` | Immediately usable by agents | No gate. Knowledge is trusted on creation. |
| `medium` | Usable but flagged for eventual review | No gate blocks, but a `knowledge.proposed` audit event is emitted with `review_requested: true`. |
| `high` | Blocks downstream capabilities | Knowledge gate blocks any capability in scope until the item is `confirmed` or `rejected`. |

Impact level is assigned at creation time by the agent or by policy rules. Operators can configure default impact levels per knowledge content type:

```yaml
knowledge:
  default_impact:
    schedule_rule: high
    preference: medium
    fact: low
```

### 3.5 Knowledge operations

The framework exposes these operations:

```typescript
interface KnowledgeGovernance {
  propose(item: Omit<KnowledgeItem, 'id' | 'governance_state' | 'created_at' | 'updated_at'>): Promise<KnowledgeItem>;
  confirm(id: string, actor_id: string): Promise<KnowledgeItem>;
  reject(id: string, actor_id: string): Promise<KnowledgeItem>;
  supersede(id: string, replacement: KnowledgeItem): Promise<KnowledgeItem>;
  revoke(id: string, actor_id: string): Promise<KnowledgeItem>;
  query(filter: KnowledgeFilter): Promise<KnowledgeItem[]>;
  checkGate(tenant_id: string, scope: string[], impact_threshold: ImpactLevel): Promise<GateResult>;
}
```

### 3.6 Integration point

The knowledge governance lifecycle powers the `knowledge` gate type from Section 1. When the gate evaluates:
1. Query for unresolved items matching the capability's scope and impact threshold.
2. If any exist, return `{ pass: false, reason: "unresolved_knowledge", blocking: [...items] }`.
3. The agent receives the blocking items and can inform the user which knowledge needs to be resolved.
4. Once the user confirms or rejects all blocking items, the gate passes on re-evaluation.

---

## Section 4: Unified Audit Trail

This extends HouseholdOS's `audit_log` schema into a cross-system audit format.

### 4.1 Audit event schema

```typescript
interface AuditEvent {
  id: string;
  timestamp: string;             // ISO 8601 with timezone
  tenant_id: string;
  principal: {
    actor_id: string;            // human who initiated the chain
    agent_id?: string;           // agent that performed the action
    session_id?: string;
    delegation_chain?: string[]; // [actor_id, agent_a_id, agent_b_id] for multi-hop
  };
  event_type: string;
  resource: {
    type: string;                // e.g., "confirmation_request", "knowledge_item", "capability"
    id: string;
  };
  outcome: 'success' | 'denied' | 'failed' | 'expired';
  payload: Record<string, unknown>;
  source_system: string;         // e.g., "mpg", "householdos", "governance-framework"
}
```

### 4.2 Event types

| Event type | Emitted when | Key payload fields |
|---|---|---|
| `gate.evaluated` | A governance gate is checked | `gate_type`, `capability`, `result`, `blocking_resources` |
| `gate.bypassed` | An operator bypasses a gate | `gate_type`, `capability`, `reason` |
| `confirmation.created` | A confirmation request is created | `capability`, `action_type`, `ttl`, `channel` |
| `confirmation.resolved` | A confirmation is confirmed/cancelled/expired | `resolution`, `resolved_by`, `latency_ms` |
| `confirmation.executed` | The confirmed action is executed | `capability`, `action_result` |
| `confirmation.failed` | Execution fails after confirmation | `capability`, `error` |
| `knowledge.proposed` | A knowledge item is created | `content_type`, `impact_level`, `source` |
| `knowledge.transitioned` | A knowledge item changes state | `from_state`, `to_state`, `transitioned_by` |
| `session.started` | An agent session begins | `agent_id`, `capabilities_granted`, `delegation_parent` |
| `session.ended` | An agent session ends | `reason` |

### 4.3 Storage interface

```typescript
interface AuditStore {
  append(event: Omit<AuditEvent, 'id'>): Promise<AuditEvent>;
  query(filter: AuditFilter): Promise<AuditPage>;
}

interface AuditFilter {
  tenant_id: string;
  event_types?: string[];
  resource_type?: string;
  resource_id?: string;
  actor_id?: string;
  agent_id?: string;
  source_system?: string;
  outcome?: string;
  after?: string;                // cursor for pagination
  before_timestamp?: string;     // ISO 8601
  after_timestamp?: string;      // ISO 8601
  limit?: number;                // default 50, max 200
}

interface AuditPage {
  events: AuditEvent[];
  cursor?: string;               // for next page
  has_more: boolean;
}
```

### 4.4 Storage requirements
- **Append-only**: INSERT only, no UPDATE or DELETE. Enforced at the storage layer (RLS policy or file append mode).
- **Tenant-scoped**: Each event is bound to a tenant_id. Storage layer enforces isolation.
- **Indexed**: timestamp + tenant_id + event_type for efficient temporal queries.
- **Retention**: Configurable per tenant. Default: 90 days. Expired events are archived, not deleted.

### 4.5 Storage backends

The audit store interface is pluggable. Provided implementations:

| Backend | Use case | Notes |
|---|---|---|
| **PostgreSQL** | Production (HouseholdOS) | Full RLS, cursor pagination, partial indexes |
| **SQLite** | Lightweight (mpg) | Single-file, WAL mode for concurrent reads |
| **JSON Lines** | Minimal (development, testing) | Append-only `.jsonl` file, grep-friendly |

### 4.6 Cross-system correlation
- `source_system` identifies which system emitted the event.
- `delegation_chain` in the principal enables tracing actions across system boundaries.
- Optional: OpenTelemetry trace context (`trace_id`, `span_id`) in the payload for distributed tracing integration.
- Cross-system queries: the audit store interface supports filtering by `source_system`, enabling unified timelines across mpg and HouseholdOS.

---

## Section 5: Integration Model

### 5.1 Architecture overview

```
┌─────────────────────────────────────────────────────┐
│                   Agent Runtime                      │
│  (Claude CLI, OpenAI SDK, custom agent)              │
│                                                      │
│  Agent requests capability ──┐                       │
└──────────────────────────────┼───────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────┐
│              Governance Framework                     │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Gate Engine  │  │ Confirmation │  │  Knowledge   │ │
│  │             │  │   Protocol   │  │  Governance  │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                │                  │        │
│         └────────────────┼──────────────────┘        │
│                          ▼                           │
│                   ┌─────────────┐                    │
│                   │  Audit Log  │                    │
│                   └─────────────┘                    │
└──────────────────────────┬───────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────┐
│            Credential Infrastructure                  │
│  (Nango / Arcade.dev / MCP Auth / direct OAuth)      │
│                                                      │
│  Token resolution, refresh, execute-on-behalf         │
└──────────────────────────────────────────────────────┘
```

The governance framework sits between the agent runtime and the credential infrastructure. The agent runtime calls gates before exercising any capability. If all gates pass, the credential layer executes the action. The framework never touches credentials directly.

### 5.2 Integration with mpg

mpg currently has no governance layer. Integration path:

1. The gate engine evaluates before Claude CLI invocation — for example, a confirmation gate fires for `!push` commands before `runClaude()` is called.
2. The confirmation protocol renders as Discord button interactions via the Discord channel adapter.
3. The audit log replaces `console.log` calls with structured `AuditEvent` records.
4. Knowledge governance is optional for mpg's use case — code-level actions (git push, file edits) do not typically involve contested knowledge, so the knowledge gate is not needed.

Specific integration points:
- `session-manager.ts` calls the gate engine before `runClaude()`. If any gate returns `{ pass: false }`, the invocation is aborted and the reason is surfaced to the user.
- `discord.ts` implements the `ChannelAdapter` interface for confirmation rendering — Confirm/Cancel buttons are Discord Button components; resolution callbacks call the framework's confirmation protocol.
- Lightweight audit storage: SQLite or JSON Lines append (no PostgreSQL requirement for mpg). The `AuditStore` interface is satisfied by the SQLite or JSON Lines backend from Section 4.5.

### 5.3 Integration with HouseholdOS

HouseholdOS already has most governance patterns as application-specific code. Integration path:

1. Extract `pending_actions` into the framework's confirmation protocol. HouseholdOS's existing `pending_actions` table maps directly to `ConfirmationRequest`; the schema migration is additive.
2. Extract `governance-gate.ts` + `governance-types.ts` into the framework's gate engine and knowledge lifecycle. HouseholdOS becomes a consumer of the framework rather than a reimplementation of it.
3. Extend `audit_log` to emit framework-standard `AuditEvent` records, enabling cross-system queries alongside mpg.

What does NOT change:
- HouseholdOS keeps its PostgreSQL backend. The framework provides the protocol; HouseholdOS provides the storage.
- Existing Row Level Security (RLS) policies remain in place. The framework does not replace or wrap them.
- LINE and Web channel adapters continue to be HouseholdOS-specific implementations of the `ChannelAdapter` interface.

### 5.4 Integration with credential infrastructure

The framework does NOT manage credentials. Its responsibility ends when all gates pass. The credential layer (Nango, Arcade.dev, direct OAuth) executes the action using whichever tokens it holds.

Integration point: the framework provides a `CredentialProvider` interface that adapters implement:

```typescript
interface GovernanceDecision {
  context: GovernanceContext;           // the original governance context (tenant, actor, session)
  gates_passed: string[];              // gate types that were evaluated and passed
  audit_event_id: string;              // ID of the gate.evaluated audit event
  confirmation_id?: string;            // ID of the ConfirmationRequest, if a confirmation gate was involved
}

interface CredentialProviderResult {
  success: boolean;
  data?: unknown;                      // action-specific result (e.g., created event ID)
  error?: string;                      // error message if success is false
}

interface CredentialProvider {
  execute(capability: string, params: Record<string, unknown>, decision: GovernanceDecision): Promise<CredentialProviderResult>;
}
```

The `GovernanceDecision` wraps the original `GovernanceContext` (Section 1.6) and adds the governance outcome — which gates passed, the audit event ID for traceability, and the confirmation ID if applicable. The credential provider includes this decision in its own audit trail, enabling end-to-end tracing from the governance evaluation to the credential execution.

The flow for a credential-dependent capability (e.g., `calendar:write`):
1. Governance framework evaluates all configured gates.
2. All gates pass → framework constructs a `GovernanceDecision` and calls `CredentialProvider.execute(...)` with it.
3. Credential provider resolves the token (via Nango, Arcade, or direct OAuth) and executes the action.
4. Result is returned to the framework, which emits a `confirmation.executed` audit event.

### 5.5 Deployment models

| Model | When to use | Storage | Credential provider |
|---|---|---|---|
| **Embedded library** | Single-app (like HouseholdOS) | App's own DB | Direct OAuth / Nango SDK |
| **Sidecar service** | Multi-app on same host (like mpg + HouseholdOS) | Shared SQLite/PostgreSQL | Shared Nango instance |
| **MCP server** | Any MCP-compatible agent | Framework-managed | Arcade.dev / MCP Auth |

The embedded library model is the lowest-friction adoption path. The sidecar model enables shared audit trails and shared confirmation state across multiple apps on the same host. The MCP server model is the fully decoupled path for agents that communicate over the Model Context Protocol.

---

## Section 6: What This Enables (Scenarios)

Concrete scenarios showing how the framework solves real problems across the two existing systems.

### Scenario A: mpg user pushes to production

1. Discord user asks Claude to `git push origin main`.
2. mpg's gate engine evaluates the `git:push` capability against its registered gates.
3. A `confirmation` gate fires → `confirmation.created` audit event emitted → Discord message with Confirm/Cancel buttons is rendered in the originating channel. Gate returns `{ pass: false, reason: "awaiting_confirmation", blocking: [confirmationRequest] }` and suspends.
4. User clicks Confirm → confirmation protocol transitions to `confirmed` → gate re-evaluates → passes.
5. Claude executes the push.
6. Audit events recorded: `confirmation.created`, `gate.evaluated` (pass after confirmation), `confirmation.resolved` (confirmed), `confirmation.executed`.

Without the framework: push happens immediately with no human check. A mistaken or malicious prompt could push directly to `main`.

### Scenario B: HouseholdOS agent schedules on contested knowledge

1. Agent attempts to evaluate a weekly schedule for a household participant.
2. A `knowledge` gate fires → queries for unresolved HIGH-impact knowledge items in the participant's scope.
3. Gate finds an unresolved item: "dad travels for work on Tuesdays" — status `needs_confirmation`.
4. Gate blocks → returns `{ pass: false, reason: "unresolved_knowledge", blocking: [knowledgeItem] }`.
5. Agent tells the user: "I can't evaluate your schedule until you confirm or reject the pending proposal about dad's Tuesday travel."
6. User confirms → knowledge item transitions from `needs_confirmation` to `confirmed`.
7. Agent re-evaluates → `knowledge` gate queries again → no unresolved HIGH-impact items → gate passes.
8. Schedule evaluation proceeds.

This pattern already works in HouseholdOS. The framework makes it reusable: any agent system with schedule-like capabilities can adopt the same knowledge gate without reimplementing the governance FSM.

### Scenario C: Cross-system audit query

1. Operator asks: "What did all my agents do yesterday?"
2. Audit query issued with `after_timestamp` and `before_timestamp` set to yesterday's bounds, no `source_system` filter.
3. Returns unified timeline across `source_system = "mpg"` and `source_system = "householdos"`: mpg sessions started and ended, HouseholdOS `calendar:write` capabilities confirmed and executed, knowledge items proposed and confirmed.
4. Operator drills into a specific confirmation: queries by `resource_type = "confirmation_request"` and `resource_id` to retrieve the full event chain from `confirmation.created` through `confirmation.executed`.

Without the framework: the operator checks two separate log systems — mpg's `console.log` output and HouseholdOS's `audit_log` table — with incompatible formats and no shared correlation identifiers. Cross-referencing an action across systems requires manual reconstruction.
