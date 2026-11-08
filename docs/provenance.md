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
| `packages/core/src/emotion/state.ts`, `policy.ts`, `observation.ts` | `src/core/emotion/state.ts`, `src/core/emotion/scoped-emotion.ts`, `src/core/emotion/telemetry-validation.ts` | Per-axis and per-label half-life decay, confidence-weighted impulses, mood and confidence EMAs, donor half-lives; scoped state per conversation | Pure functions over a snapshot; strict policy and estimator-reading parsing (a malformed reading changes nothing, non-finite numbers throw); low-confidence telemetry is recorded but never applied; audio and satellite classifiers not ported |
| `packages/core/src/emotion/appraisal-gate.ts`, `application/emotion-service.ts` | `src/core/emotion/appraisal.ts`, `src/core/emotion/narrative-appraisal-drift.ts`, `src/system/config/narrative-emotion-appraisal-config.ts`, `src/core/agent/substrate-agent/emotion-self-model-runtime.ts` | Drift-only gate at 0.35 with baseline seeding and untrusted skip; appraisal over the recent transcript | The pending appraisal is part of the compare-and-set state, settled only after a machine-authored entry is appended, so failures retry; observations are idempotent per turn; reads only from a trusted, fresh, same-scope estimate |
| `packages/core/src/emotion/self-model.ts` | `src/core/self-model/state.ts` | Certainty, engagement, processing, trajectory and salient-term heuristics | Deterministic, computed from the turn and stored with the state; no free-text self-description |
| `packages/core/src/intention/concerns.ts`, `application/concern-service.ts` | `src/core/intention/concerns.ts`, `src/core/intention/concern-visibility.ts`, `src/core/intention/concern-resolution-appraisal.ts`, `src/core/intention/concern-resolution-arc.ts`, `src/core/appraisal/concern-arc-prose.ts`, `src/core/intention/tools.ts` | Transition matrix with evidence-required reopen, duplicate detection by Dice similarity, relief delta, arc prose | Arc text is machine-authored, not first-person companion speech; relief applies once per resolution generation and only in the concern's own emotion scope (the donor had one global VAD); evidence sensitivity must be admitted; the hidden-item count is not ported; every revision has an event |
| `packages/core/src/intention/follow-ups.ts`, `application/follow-up-service.ts` | `src/core/intention/pending-follow-ups.ts` | Idempotent follow-ups by target, content and due time | Targets resolve through the session catalog and are gated by `canViewerRead`; activation is compare-and-set |
| `packages/core/src/application/self-state-context.ts` | `src/core/scheduler/reflection-template-runtime/prompt-formatting.ts` | Inner-state, concern and reflection sections in internal context | Typed origins keep inferred state, authored reflection and signals apart; each item passes dispatch's declared-restriction check, including worker rules; reflections are read through a narrow port without journals |
| `packages/adapters/src/postgres/self-state-stores.ts`, `migrations/0003_self_state.sql` | none (the donor kept this state in agent memory and files) | Durable emotion, concern and follow-up state | JSONB records with compare-and-set; observation and state written in one transaction; lists filtered and paged in SQL by cursor; included in the state backup |

Memory, episodes and journals (psfn-lite-vvn.5). These were written new for
Lite from the donor's algorithms, contracts and tests at the donor revision
above. No donor code was copied.

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/core/src/memory/access.ts` | `src/faculties/memory/subject-authorized-store.ts`, `src/faculties/memory/tools/visibility.ts` | Mandatory subject authorization; unauthorized subjects read as absent | Access is plain data, applied by stores before ranking and limits; companion-internal subjects only in self turns |
| `packages/core/src/memory/evolution.ts`, `application/memory-writer.ts` | `src/faculties/memory/writer.ts`, `src/faculties/memory/writer/reconciliation.ts`, `src/faculties/memory/lexical-match.ts`, `src/faculties/memory/types.ts` | Dedup thresholds per kind, related offset, current-state, compatible-update, negation and contrast rules | Destructive supersede requires equal or higher attribution authority; candidates limited to what the writer may read; atomic write receipts make retries replay |
| `packages/core/src/memory/extraction.ts`, `application/memory-extraction.ts` | `src/faculties/memory/extraction/orchestrator.ts`, `llm-pass.ts`, `parser.ts`, `speaker-routing.ts`, `src/core/contacts/tracking-gate.ts` | Model proposes, runtime routes subjects to the attributed speaker, untracked contacts get nothing | Whole-output rejection on any malformed entry; per-session watermark advanced only after every write |
| `packages/core/src/application/memory-service.ts`, `memory-administration.ts`, `scratchpad-service.ts`, `handlers-memory.ts` | `src/faculties/memory/tools.ts`, `src/faculties/memory/deletion-proposals.ts`, `src/faculties/memory/tools/scratchpad.ts`, `src/faculties/memory/scratchpad-visibility.ts`, `src/faculties/subagents/memory-governance.ts` | Search, census, shared background, import, patch, deletion proposals, same-day scratchpad, worker staging | Hybrid search reports lexical and semantic health; companion-global scratchpad notes only from self turns; restore of a soft delete |
| `packages/core/src/episodes/rules.ts`, `application/episode-formation.ts`, `episode-service.ts` | `src/faculties/memory/episodic/synthesis.ts`, `sleep-consolidation.ts`, `synthesis/consolidation.ts`, `arc-formation.ts`, `src/faculties/memory/retrieval/episodic.ts`, `episode-search.ts`, `episode-drilldown.ts` | 45-minute segmentation, salience and themes, sitting consolidation, participant/theme arcs | Short exchanges kept as `brief` episodes without a model call; empty ranges reported; meaning-bearing episodes frozen; arcs withheld unless every member is readable |
| `packages/core/src/journals/rules.ts`, `application/journal-service.ts`, `letter-service.ts` | `src/boundary/integrations/journal/tools.ts`, `provenance.ts`, `src/persistence/journals/reflection-journal.ts`, `src/core/letters/service.ts`, `src/core/tools/letter.ts` | Runtime-stamped note provenance, restricted merges, letter states and Partner draft privacy | Notes and reflections in Postgres; letter lived history as an event table instead of a JSONL channel; disposition actions excluded with the wiki |
| `packages/core/src/application/memory-maintenance.ts` | `src/faculties/memory/sleeptime-agent.ts` | Ordered nightly memory passes | No wiki pass; every failure reported and retried from its watermark; embedding backfill |
| `packages/adapters/src/postgres/migrations/0002_memory_state.sql`, `memory-*.ts`, `episode-stores.ts`, `journal-stores.ts` | `src/faculties/memory/episodic/store-port.ts`, `src/persistence/postgres/migrations.ts` | pgvector embeddings, full-text search | Access predicates in SQL; per-space dimension checks and partial HNSW indexes; tables joined to the structured-state backup |

Shared automata, bounded workers, activity and free time (psfn-lite-vvn.7).
Written new for Lite from the donor's contracts, algorithms and tests at the
donor revision above. No donor code was copied. Shards, charge, the fleet
scheduler and the findings bus were not ported.

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/core/src/automata/types.ts`, `rules.ts`, `application/worker-runner.ts`, `worker-session.ts` | `src/faculties/subagents/types.ts`, `src/faculties/subagents/task-registry.ts`, `src/core/agent/background-work/store-port.ts`, `src/core/agent/background-work/recovery-contract.ts` | Run lifecycle with leases, bounded attempts, cancellation and lease-expiry recovery; results bound to their source | Per-turn and scheduled workers share one runner; the host runs the model loop through a `WorkerSession` while core owns grant, scope, lease, turn budget and result; driving again needs a freshly admitted scope for the same audience and principal; a requeued run nothing drives within a grace window settles as `not_resumed` instead of waiting forever |
| `packages/core/src/application/worker-effects.ts` | `src/core/agent/background-work/store-port.ts` (effect receipts), `src/core/agent/background-work/recovery-contract.ts` | Effect receipts started before the effect, settled once; ambiguous outcomes never re-executed | Host-supplied effect keys with request digests; an unsettled receipt blocks the run instead of requeueing it |
| `packages/core/src/application/automata-service.ts`, `handlers-automata.ts`, `worker-review.ts` | `src/faculties/subagents/tools.ts`, `src/faculties/subagents/task-visibility.ts`, `src/faculties/subagents/capability-access.ts`, `src/faculties/subagents/memory-governance.ts` | spawn, message, wait, cancel, status, discover, inspect; runs visible only to their source audience; grant intersected with the parent; restricted writes staged for review | `wait` is non-blocking; spawn is idempotent per conversation and key; a wider grant is refused, not trimmed; inspect shows effect phases, never transcripts |
| `packages/core/src/application/activity.ts`, `activity/types.ts`, `application/current-turn.ts` | `src/core/agent/tool-surface/registry.ts` (activity surface), `src/faculties/subagents/task-visibility.ts` | Activity as current and recent work with artifacts | Explicit visibility audience checked by `canViewerRead`; writes only from the record's own conversation; a worker run's activity is settled only by the runner; workers see only their own run's activity; compare-and-set updates that never re-settle |
| `packages/core/src/scheduler/free-time-gate.ts`, `policy.ts`, `time.ts`, `application/free-time-service.ts` | `src/core/scheduler/free-time.ts`, `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window.ts`, `src/core/scheduler/rest-window-policy.ts` | Quiet-hours and idle lanes, minimum interval, daily cap, extend-only rest, selection only from pre-built options | The choice is made with governed tool actions in a companion-internal turn instead of a tool-less JSON call; the block is recorded before asking and the store holds one open block across lanes, so overlapping passes cannot both invite; lapse, failure and interruption are typed and never presented as the companion's decision; a stale block is never re-run |
| `packages/core/src/application/schedule-service.ts`, `handlers-scheduler.ts` | `src/core/scheduler/schedule-tool.ts`, `src/core/scheduler/scheduled-prompts.ts`, `src/core/scheduler/reflection-policy.ts` | One-shot self-prompts with an explicit zone, reflection templates with manual or daily schedules, busy deferral | Runs fenced running → settled, so a crash leaves `interrupted` and nothing repeats; a marker counts as stranded only after an in-flight window, and a lost compare-and-set skips the item; DST-skipped times are invalid; template updates validate the schedule before writing |
| `packages/core/src/intention/care-reminders.ts`, `application/care-reminder-service.ts` | `src/core/intention/care-reminders.ts` | Once and daily care reminders | Targeted and gated like follow-ups; delivery fenced so a crash or an ambiguous host result yields an unknown occurrence, never a second send; a daily reminder moves on to its next day |
| `packages/core/src/application/reflection-reader.ts` | none (vvn.6 left the port unwired) | Authored reflections in the self-model context | The journals' reflection store implements `AuthoredReflectionPort` |
| `packages/adapters/src/postgres/automata-stores.ts`, `scheduler-stores.ts`, `record-rows.ts`, `migrations/0004_activity_automata.sql` | `src/core/agent/background-work/store-port.ts` | Durable runs, receipts and rest | JSONB records with constraint-only columns and compare-and-set; extend-only rest enforced by the upsert; one open free-time block enforced by a partial unique index; included in the state backup |

Pi harness and standalone composition (psfn-lite-vvn.8). Written new for Lite
against the public API of `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 0.84.1, the versions the donor pins. No donor code was
copied. The donor's `SubstrateAgent` and its loop patch were deliberately not
ported.

| Lite path | Donor path | Retained behavior | Deliberate change |
| --- | --- | --- | --- |
| `packages/pi/src/companion-harness.ts`, `loop.ts`, `context.ts`, `settlement.ts` | `src/core/agent/substrate-agent.ts`, `src/boundary/pi-agent/agent-loop-patch.ts` | Pi runs the model loop with the companion's tools; interrupted and failed turns are recorded | Public `runAgentLoop` only, no patch of Pi internals; a fresh context per turn from canonical history instead of a long-lived agent; every turn goes through core's prepare/commit/abort/recover; post-turn emotion observation and worker resumption |
| `packages/pi/src/tools.ts` | `src/boundary/pi-agent/substrate-agent-tool.ts` | Domain tools exposed to Pi | One Pi tool per inventory tool with an action enum; every call through core's dispatcher under the turn scope; refusals surface as labelled tool errors |
| `packages/pi/src/worker-host.ts`, `inference.ts`, `embeddings.ts` | none | none | Lite-new implementations of core's worker, model, affect-estimator and embedding ports |
| `apps/standalone/src/*` | none (the donor's composition root was excluded) | none | Explicit validated configuration, a local host authenticator and a CLI over one composition function |
