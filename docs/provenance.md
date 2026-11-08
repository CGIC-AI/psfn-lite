# Source provenance

PSFN Lite is derived from https://github.com/CGIC-AI/psfn-framework.

Initial inspected donor revision: `e6a9546051f4e92bf7218b133b4523ac53a797c0`.

Bootstrap copied artifacts:

| Lite path | Donor path | Treatment |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | Unmodified inherited license text |
| `docs/framework-agent-contract.md` | `AGENTS.md` | Unmodified reference snapshot; not the active Lite operating contract |

The root AGENTS.md is adapted for Lite. The charter and architecture documents
record the requested derivative scope. No runtime source, data, dependencies,
deployment configuration or private evidence has been imported.

Core interface contracts (psfn-lite-vvn.3). These were written new for Lite
from the donor's contracts and invariants at the donor revision above. No donor
code was copied. Every tool action also records its donor paths in
`TOOL_INVENTORY` (see [tool-inventory.md](tool-inventory.md)).

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/core/src/application/tool-inventory.ts`, `*/tool.ts` | `src/core/agent/tool-surface/registry.ts`, per-tool sources | One semantic tool per domain with actions; retired aliases not ported | Registry is frozen data with privacy, restrictions, worker access and donor mapping per action; wiki, notify, system, self_status, analysis_workbench, automata_bus, identity staging and introspection excluded |
| `packages/core/src/shared/privacy.ts` | `src/system/trust/policy.ts`, `src/system/trust/context-envelope.ts` | Trust ladder and ceilings: trusted/regular share public+personal, only primary sees intimate/confidential in a direct room | Ceilings are a validated, versioned owner policy that cannot widen for wider rooms; unknown trust rejects instead of defaulting to regular |
| `packages/core/src/application/ingress.ts`, `trusted-scope.ts` | `src/primitives/llm/request-context.ts`, `src/core/session/session-viewer-access.ts` | Viewer authority comes from admitted request context, never tool arguments | Authority is an explicit unforgeable scope argument, not ambient context; unknown, untracked or blocked callers reject |
| `packages/core/src/application/turn-lifecycle.ts`, `turn-history.ts`, `sessions/types.ts` | `src/core/turns/id.ts`, `src/core/session/turn-provenance.ts`, `src/shared/contracts/runtime.ts` | Turn identity, actor provenance, append-only canonical history | Explicit prepare/commit/abort with session revision, harness ownership and idempotency keys; interrupted and failed turns recorded; ledger-first settlement with history derived from the record, and lease-based recovery of abandoned turns are Lite-new |
| `packages/core/src/shared/attribution.ts`, `application/context.ts` | `src/core/session/entry-attribution.ts` | Internal-origin content is never presented as user speech | Seven typed origins with a role derived from the origin |
| `packages/core/src/application/dispatch.ts`, `automata/types.ts` | `src/faculties/subagents/capability-access.ts`, `src/faculties/subagents/memory-governance.ts`, `src/faculties/subagents/task-visibility.ts` | Worker grant is an intersection with the parent; no recursion; destructive memory operations denied | Worker access declared per action in the inventory and enforced centrally |
| `packages/core/src/scheduler/types.ts` | `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window-policy.ts` | Extend-only durable rest; selection only from pre-built options | Failure-caused rest is typed as `system_failure`, never as the companion's decision |
| `packages/core/src/episodes/types.ts` | `src/shared/contracts/episodic-memory.ts`, `src/faculties/memory/episodic/store-port.ts` | Meaning is companion-only, machine signals separate, compare-and-set meaning writes | A governed `author_meaning` action for self turns (donor had none) |
| `packages/core/src/contacts/tool.ts`, `intention/tool.ts` | `src/core/contacts/tools.ts`, `src/core/intention/tools.ts` | Trust/relationship approval proposals, concern visibility | Contact writes and concern resolve/transition are visibility-gated (donor gaps) |

Every later extraction must record donor revision, source/test paths, retained
behavior and deliberate changes here or in a linked module provenance document.
Preserve applicable notices. Prefer reusing cohesive domain implementations and
tests over copying composition roots or introducing a dependency on the framework.

Hermes integration reference: https://github.com/NousResearch/hermes-agent.
No Hermes revision is selected or implementation copied yet. Pin the revision
used for the compatibility proof and record the actual plugin/MCP capabilities
tested before claiming support.
