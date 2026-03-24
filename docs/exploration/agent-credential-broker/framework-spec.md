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

<!-- Section 2: Knowledge Governance Lifecycle — to be added -->

<!-- Section 3: Confirmation Protocol — to be added -->

<!-- Section 4: Unified Audit Trail — to be added -->

<!-- Section 5: Tenant and Multi-System Deployment — to be added -->

<!-- Section 6: Open Questions and Deferred Decisions — to be added -->
