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

Durable sessions, contacts, privacy and identity (psfn-lite-vvn.4). These were
written new for Lite from the donor's contracts, algorithms and invariants at
the donor revision above. No donor code was copied.

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/core/src/shared/privacy.ts` (`canViewerRead`, `audienceDisclosureClass`) | `src/core/session/search-runtime.ts` (`visibilityToSensitivity`), `src/core/session/session-viewer-access.ts` | Room disclosure classes: direct confidential, small group personal, large group and broadcast public; own conversation always readable | Self-audience history readable only from self turns; workers additionally capped by their grant ceiling |
| `packages/core/src/application/session-service.ts`, `transcript-projection.ts`, `handlers-session.ts` | `src/core/tools/session.ts`, `src/core/session/continuity.ts`, `src/core/session/continuity-artifacts.ts`, `src/core/session/focus-knowledge.ts`, `src/app/maintenance/transcript-projection-repair.ts` | List, grep, search, messages, new/resume with lineage, wake/return notes, focus with completion knowledge; projection repair from the canon | Sessions bound to one audience and enforced in `prepareTurn`; projection served only after a head and hash proof, otherwise rebuilt; cross-audience resume starts a continuation; model summaries machine-attributed |
| `packages/core/src/contacts/authority.ts`, `policy.ts`, `application/contact-service.ts`, `contact-administration.ts`, `handlers-contact.ts` | `src/core/contacts/tools.ts`, `src/core/contacts/contact-store-port.ts`, `src/core/contacts/contact-merge-policy.ts`, `src/core/contacts/store/identity-utils.ts`, `src/core/contacts/tracking-gate.ts` | Trust and relationship ladders with approval proposals, tracking consent, untracked speakers get no dossier, identity linking, human/machine merge refusal | Ingress authority follows merges with a hop limit and fails closed; merges never widen trust or consent; revoked consent denies; non-granted consent also refuses every dossier write and hides notes; every write is visibility-gated and audited |
| `packages/core/src/identity/rules.ts`, `application/orientation-service.ts`, `values-service.ts`, `handlers-identity.ts` | `src/faculties/core-memory/store.ts`, `src/faculties/core-memory/tools.ts`, `src/core/identity/prompt-tools.ts`, `src/core/identity/runtime-prompt-layers.ts`, `src/faculties/values/store.ts`, `src/faculties/north-star/store.ts` | Block limits (persona 2400, human 2400, goals 1600), exact-once replace, append-only layer versions with rollback and toggle, protected layer types and persona fields, values revisions, at most three North Star items | Over-limit writes reject instead of truncating; protected changes are stale-checked proposals; every block, layer and North Star write is compare-and-set |
| `packages/core/src/application/backup.ts` | `src/persistence/backups/service.ts`, `src/persistence/backups/restore-verify-preconditions.ts`, `src/persistence/backups/postgres-restore.ts` | Manifest with per-file digests, verify before restore | Fixed component set; restore only into empty targets, each component proving the fingerprint before its import becomes durable; every component fingerprinted before the first and after the last export, so cross-component skew fails the backup; no encryption, retention or fleet scope |
| `packages/adapters/src/fs/session-archive.ts`, `history-chain.ts`, `layout.ts` | `src/persistence/jsonl.ts`, `src/persistence/jsonl-segments.ts` | Append-only per-session JSONL as canonical history | Hash-chained lines, fsync'd single-write appends, torn-tail quarantine, fail-closed damaged sessions, root lock with same-pid stale takeover, disjoint storage roots; backup sets only under the backup root |
| `packages/adapters/src/postgres/migrations.ts`, `migrations/0001_continuity_state.sql` | `src/persistence/postgres/migrations.ts`, `src/persistence/postgres/session-migrations.ts`, `src/persistence/postgres/contact-migrations.ts` | Versioned migrations with pgvector | One checksummed migration chain under an advisory lock; drift stops startup |
| `packages/adapters/src/postgres/*-store*.ts`, `state-backup.ts` | `src/core/contacts/postgres-adapter/store.ts`, `src/persistence/backups/postgres-restore.ts` | Contact identity uniqueness, transactional merge | JSONB records in core's shape with constraint-only columns; consistent-snapshot export rendered in UTC, restored into an empty same-schema database and fingerprint-checked before commit |
| `tests/support/postgres-harness.ts` | `src/test-support/postgres-test-harness.ts` | Pinned pgvector image, tmpfs data, label, random port | Never reuses or touches another container; removes exactly its own; fails loudly without Docker unless explicitly opted out |

Every later extraction must record donor revision, source/test paths, retained
behavior and deliberate changes here or in a linked module provenance document.
Preserve applicable notices. Prefer reusing cohesive domain implementations and
tests over copying composition roots or introducing a dependency on the framework.

Hermes integration reference: https://github.com/NousResearch/hermes-agent.
No Hermes revision is selected or implementation copied yet. Pin the revision
used for the compatibility proof and record the actual plugin/MCP capabilities
tested before claiming support.

Emotion, self-model, concerns and reflection continuity (psfn-lite-vvn.6).
Written new for Lite from the donor's algorithms and tests at the donor
revision above. No donor code was copied, and SubstrateAgent ownership was
removed: core services take explicit ports, and the host calls `observeTurn`.

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/core/src/emotion/state.ts`, `policy.ts` | `src/core/emotion/state.ts`, `src/core/emotion/scoped-emotion.ts`, `src/core/emotion/telemetry-validation.ts` | Per-axis and per-label half-life decay, confidence-weighted impulses, mood and confidence EMAs, donor half-lives; scoped state per conversation | Pure functions over a snapshot; strict policy parsing; low-confidence telemetry is recorded but never applied; audio and satellite classifiers not ported |
| `packages/core/src/emotion/appraisal-gate.ts`, `application/emotion-service.ts` | `src/core/emotion/appraisal.ts`, `src/core/emotion/narrative-appraisal-drift.ts`, `src/system/config/narrative-emotion-appraisal-config.ts`, `src/core/agent/substrate-agent/emotion-self-model-runtime.ts` | Drift-only gate at 0.35 with baseline seeding and untrusted skip; appraisal over the recent transcript | The pending appraisal is part of the compare-and-set state, settled only after a machine-authored entry is appended, so failures retry; observations are idempotent per turn; reads only from a trusted, fresh, same-scope estimate |
| `packages/core/src/emotion/self-model.ts` | `src/core/self-model/state.ts` | Certainty, engagement, processing, trajectory and salient-term heuristics | Deterministic, computed from the turn and stored with the state; no free-text self-description |
| `packages/core/src/intention/concerns.ts`, `application/concern-service.ts` | `src/core/intention/concerns.ts`, `src/core/intention/concern-visibility.ts`, `src/core/intention/concern-resolution-appraisal.ts`, `src/core/intention/concern-resolution-arc.ts`, `src/core/appraisal/concern-arc-prose.ts`, `src/core/intention/tools.ts` | Transition matrix with evidence-required reopen, duplicate detection by Dice similarity, relief delta, arc prose | Arc text is machine-authored, not first-person companion speech; relief applies once per resolution generation; evidence sensitivity must be admitted; the hidden-item count is not ported; every revision has an event |
| `packages/core/src/intention/follow-ups.ts`, `application/follow-up-service.ts` | `src/core/intention/pending-follow-ups.ts` | Idempotent follow-ups by target, content and due time | Targets resolve through the session catalog and are gated by `canViewerRead`; activation is compare-and-set |
| `packages/core/src/application/self-state-context.ts` | `src/core/scheduler/reflection-template-runtime/prompt-formatting.ts` | Inner-state, concern and reflection sections in internal context | Typed origins keep inferred state, authored reflection and signals apart; each item is admission-gated; reflections are read through a narrow port without journals |
| `packages/adapters/src/postgres/self-state-stores.ts`, `migrations/0003_self_state.sql` | none (the donor kept this state in agent memory and files) | Durable emotion, concern and follow-up state | JSONB records with compare-and-set; observation and state written in one transaction; included in the state backup |
