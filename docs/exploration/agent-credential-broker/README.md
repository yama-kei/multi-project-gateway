# Agent Credential & Permission Broker — Exploration

Issue: #35 | Vision: #34

## Purpose

Formalize the credential and permission patterns already present in mpg and
HouseholdOS, identify overlap and gaps, and design a shared broker that both
projects (and future agent systems) can consume.

## Phase 1: Protocol Formalization (complete)

| Document | Description |
|---|---|
| [mpg-protocol.md](mpg-protocol.md) | mpg's implicit credential & permission model |
| [householdos-protocol.md](householdos-protocol.md) | HouseholdOS's credential & permission model |
| [gap-analysis.md](gap-analysis.md) | Overlap, gaps, and broker requirements |

## Phase 2: Framework Design (current)

| Document | Description |
|---|---|
| [framework-spec.md](framework-spec.md) | Agent Governance Framework design specification |

Key design decisions:
- **Governance, not credentials** — credential plumbing delegated to Nango/Arcade.dev/MCP Auth
- **Four primitives** — governance gates, confirmation protocol, knowledge lifecycle, unified audit
- **Extracted from real code** — HouseholdOS's `pending_actions`, governance FSM, and audit_log generalized
- **Three deployment models** — embedded library, sidecar service, MCP server

## Phase 3: Prototype (next)

TBD — informed by Phase 2 design.
