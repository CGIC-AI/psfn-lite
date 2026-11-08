# Architecture and extraction decisions

Status: agreed direction from the founding design conversation; implementation
details must be demonstrated against source and contract tests.

## Two product parts

The persistent companion core owns identity and continuity. The replaceable
harness owns execution of a conversation or activity. Pi is the native harness;
Hermes is the only alternate integration target in the initial scope.

Module layout. `packages/core` exists (package `lite-core`, public entry
`src/index.ts`) with each domain's types, core-owned ports and tool descriptor,
plus the application boundary described below. Domain behavior, storage and
every other package are planned, not implemented.

- `packages/core/src/identity`: persona, constitution, values, North Star, orientation.
- `packages/core/src/sessions` and `contacts`: archive lifecycle, trusted identity,
  consent, audience and disclosure scope.
- `packages/core/src/memory`: core/typed memory, extraction, retrieval, evolution.
- `packages/core/src/episodes` and `journals`: episodes, arcs, authored meaning,
  autobiographical and reflection records with distinct authority.
- `packages/core/src/emotion` and `intention`: emotion, self-model, concerns,
  weighted intentions and follow-ups.
- `packages/core/src/activity`: current/recent work, artifacts, status and provenance.
- `packages/core/src/automata` and `scheduler`: bounded workers, durable work,
  free-time choice, rest and maintenance.
- `packages/core/src/shared` and `application`: shared primitives and the
  cross-domain use cases (ingress, turn lifecycle, dispatch, activity).
- Planned: `packages/adapters` (persistence, model/embedding access and host
  capabilities), `packages/pi` (the native conversation/activity harness),
  `packages/mcp` (governed domain tool transport), `integrations/hermes` (native
  Python plugin and lifecycle bridge) and `apps/standalone` (thin composition for
  the Pi edition and local core service).

These are module seams, not a requirement for separate processes or a package
per noun. Keep internal modules private behind deliberately small interfaces.
Core-owned interfaces prevent adapter imports from flowing inward. Cross-domain
coordination belongs to explicit application use cases, not a universal object.

## Core boundary

Dependency direction is enforced by `tests/boundary/core-imports.test.ts`, which
parses every production file in `packages/core/src` with the TypeScript compiler
API. Core imports nothing outside the package except `node:` builtins. `shared`
imports only `shared`. A domain imports `shared`, its own files and other domains
only through their `index.ts`, never `application`; the domain graph is acyclic.
`application` reaches domains only through their index. The root `index.ts`
re-exports layer index files and is the only public entry.

Each domain exposes narrow ports for the state it owns (for example
`TurnLedgerPort` and `SessionArchivePort` in sessions, `ContactAuthorityPort` in
contacts, `MemoryReadPort` in memory). `application/host-ports.ts` declares what
the host supplies: caller authentication, model, embedding and approval queue.
Adapters implement these interfaces later; core contains no storage and no
in-memory fallback.

- **Trusted ingress** (`createTrustedIngress`) turns host-verified evidence into a
  `TrustedTurnScope`: caller, contact, trust, audience and admitted sensitivities
  under an owner-versioned `DisclosurePolicy` that is validated and may not widen
  for wider rooms. Unknown, untracked or blocked callers, malformed attestations
  and internal turns outside a self audience reject. Only scopes minted by ingress,
  or narrowed from one for a worker, pass `isTrustedTurnScope`. Model arguments
  never contribute authority, and the dispatcher rejects arguments named like it.
- **Turn lifecycle** (`createTurnLifecycle`): `prepareTurn` checks the session
  revision the harness assembled context against, allows one open turn per
  session, binds the trigger's attribution from the scope and archives it at once.
  `commitTurn` records completed turns; `abortTurn` records interrupted and failed
  ones with delivery status and any partial reply. Only the owning harness
  instance may settle a turn; handover goes through an explicit abort. An
  idempotency key replays a settled turn instead of re-executing, and reuse with a
  different request is a conflict.
- **Dispatch** (`createToolDispatcher`) resolves `tool.action` against the
  inventory, enforces admission, `foreground_only`, `self_audience_only` and
  worker grants, then calls the owning domain handler. A missing handler is
  `unavailable`, never a silent no-op. Results are attributed as tool output.
- **Activity** (`createActivityService`) records purpose, status, outcome,
  artifacts and attributed notes bound to the source turn and audience. Another
  audience's activity reads as missing.

Failure semantics are types (`shared/result.ts`): every operation returns a
`Result` whose failures are `denied`, `not_found` (also used for items the
audience may not see), `conflict` (stale revision, turn ownership, open or
settled turn, idempotency mismatch, with expected/actual revisions), `invalid`
or `unavailable`. Internal context carries one of seven origins (participant
speech, companion speech, tool result, system note, internal signal, machine
inference, authored reflection). Only participant speech renders in the
participant role, and only an admitted participant scope can produce it.

Pi and Hermes enter the same way with no service locator or universal options
object. Each host authenticates its caller, then calls `ingress.admit`, then
`prepareTurn`, `dispatcher.dispatch` for every tool call, and finally `commitTurn`
or `abortTurn`. A tool transport such as MCP maps calls to `dispatch`; the Hermes
native plugin maps its lifecycle hooks to prepare/commit/abort. Each use case
takes only the ports it needs, and both surfaces share one inventory and one set
of handlers.

## Shared companion state and tool surface

All surfaces use one authoritative companion state. A harness reset, compaction,
or replacement cannot reset identity or silently fork personal continuity.
Prepare a scoped turn, execute under explicit ownership, record actual outcomes
and delivery status, then schedule recoverable effects. Background results bind
to their source event and state revision; retries do not duplicate effects.

Expose the complete selected companion tool inventory: orientation, core and
long-term memory, sessions/history, episodes/arcs, journals/reflections, contacts,
emotion/self-state, concerns/follow-ups, values/North Star, activity/artifacts,
automata/subagent lifecycle, and free-time/rest inspection and choice. Inventory
existing tools before implementing so the MCP does not become another narrow
memory-only bridge. Preserve domain-specific write/review restrictions.

Use one semantic model-facing tool per domain, with actions. Internal services
must not be merged merely to present that surface. MCP and the Hermes native
plugin call those same governed operations; neither duplicates business logic.

The inventory is runtime data (`TOOL_INVENTORY`) with an owning domain, access,
privacy class, admission, restrictions, worker access and donor mapping for every
action. The full per-action table is in [tool-inventory.md](tool-inventory.md).

| Tool | Domain | Actions | Default privacy | Main donor source |
| --- | --- | --- | --- | --- |
| `orient` | identity | view, append, replace, reorient, layer reads, update/rollback/toggle layer, update_persona | conversation-scoped blocks; identity by design | `src/faculties/core-memory/tools.ts`, `src/core/identity/prompt-tools.ts` |
| `values` | identity | list/add/revise values, North Star list/create/update/reorder/retire | values audience-scoped (personal); North Star identity by design | `src/faculties/values/tools.ts`, `src/faculties/north-star/tools.ts` |
| `memory` | memory | search, get, shared_background, census, write, import, patch, propose_delete, restore, scratchpad_* | audience-scoped; scratchpad conversation-scoped | `src/faculties/memory/tools.ts`, `src/faculties/memory/tools/scratchpad.ts` |
| `session` | sessions | list, search, grep, messages, continuity_list, new, resume, wake_return, start/complete_focus | audience-scoped | `src/core/tools/session.ts` |
| `episode` | episodes | search, get, timeline, author_meaning | audience-scoped; meaning companion-private | `src/faculties/memory/retrieval/episodic.ts` |
| `journal` | journals | list, read, search, write, append, reflections_list/read, letter_* | conversation-scoped; reflections and letters companion-private | `src/boundary/integrations/journal/tools.ts`, `src/core/tools/letter.ts` |
| `contact` | contacts | list, search, lookup, note, set/propose trust, set/propose relationship, link_identity, set_channel_privacy, set_machine_intelligence, block, unblock | audience-scoped, writes visibility-gated | `src/core/contacts/tools.ts` |
| `emotion` | emotion | read, appraisals, self_report | scope-local; appraisals companion-private | new (`src/core/emotion/state.ts`) |
| `concern` | intention | list, create, resolve, transition, follow_up_*, reminder_create | audience-scoped | `src/core/intention/tools.ts`, `src/core/scheduler/schedule-tool.ts` |
| `activity` | activity | recent, get, start, update | audience-scoped | new |
| `automata` | automata | spawn, message, wait, cancel, status, discover, inspect | conversation-scoped | `src/faculties/subagents/tools.ts` |
| `free_time` | scheduler | status, choose, rest, defer, scheduled_list, schedule_prompt, update/run_template | companion-private | new (`src/core/scheduler/free-time-chooser.ts`), `src/core/scheduler/schedule-tool.ts` |

Activity records make 'what have you been doing?' answerable without waiting
for a summarizer to promote an event into long-term memory. Keep purpose,
status, outcome, artifact references and relevant authored reflection. Awareness
does not imply disclosure permission to every audience.

## Free time and automata

Free time is part of v1. A cheap deterministic eligibility check can invite the
companion to choose an activity or rest. Choosing may require inference; do not
claim it is zero-cost. Execution uses the active harness and permitted tools.
Respect durable quiet/rest decisions, interruption, stop and deferral; do not
keep prompting after a refusal or simulate a companion decision on failure.

Automata are task-specific workers triggered per turn, on a schedule, or by an
explicit request. A shared lifecycle supplies authority, status, cancellation,
bounded retries, durable completion and provenance. Machine-produced summaries
are not companion-authored affect or meaning. Keep restricted-memory candidate
review independently of shards. Do not import the full findings bus by default.

## Host responsibility and Hermes

The host owns credential custody, execution isolation, approvals, provider
access, channel delivery and practical tools. The core owns contact/audience
authorization, memory disclosure, continuity and authorship. Module separation
alone is not a sandbox for host shell execution.

Use Hermes native integration for lifecycle, identity, context and activity
execution; use MCP for the tool transport where appropriate. Verify available
hooks and version-pin the tested integration. A memory provider alone cannot
establish the required lifecycle guarantees. Do not run competing personal
memory/identity authorities, disguise internal context as user speech, or rely
only on successful-turn hooks for archival completeness.

The initial proof must cover interrupted/failed turns, compaction, restarts,
contact/audience changes, free-time activity, and harness handover. When a host
cannot preserve an invariant, report that integration gap explicitly.

## Reuse assessment

Reference paths below are in PSFN Framework at the donor revision in provenance.md.

| Area | Reuse | Rework |
| --- | --- | --- |
| Identity | `core/identity`, `faculties/core-memory`, `faculties/values`, `faculties/north-star` domain behavior | Prompt/context wiring and narrow state interfaces |
| Memory/episodes | `faculties/memory` algorithms, provenance, authorization, authorship and tests | Explicit policy/storage dependencies and public operations |
| Sessions | `SessionArchivePort`, transcript projection/search, integrity primitives | Large `core/session/manager.ts` coordinator |
| Contacts | Identity, tracking consent, trust and audience rules | Gateway/fleet/channel lifecycle interfaces |
| Emotion/intention | State, meaningful-change appraisal, concern lifecycle | Ownership currently inside `SubstrateAgent` |
| Worker execution | `core/agent/background-work` recovery/effect fences; subagent policy | Runner that currently constructs full `SubstrateAgent` |
| Scheduler | Cheap near-turn work, rest persistence, consolidation algorithms | All-or-nothing sleep wiring and wiki dependency |
| Pi | Upstream boundary concepts and selected behavior | Private-internal loop graft; rebuild only demonstrated necessities |

Do not import `app/startup/composition/composition.ts`, `SubstrateAgent`, or
`persistence/runtime-factory.ts` wholesale. Explicitly remove the retriever's
optional authorization default. Removing wiki must not disable sleep maintenance.

Initially preserve Postgres/pgvector for structured runtime state and filesystem
JSONL for canonical history. A lighter storage backend is a separate evaluated
decision, not part of the initial extraction. Keep storage adapters replaceable.

## Exclusions and proof

No PSFN Gateway, satellites, fleet, shared worlds, shards, charge, full Garden,
or generalized support for arbitrary harnesses. No live migration or deployment
is authorized by repository creation. No personal data is imported.

Prove isolation and continuity with synthetic scenarios: harness handover,
cross-surface activity recall, complete journal/tool access, denied wrong-contact
reads, first-person authorship preservation, idempotent worker recovery, quiet
rest across restart, and complete backup/restore. Measure dependency footprint,
idle inference, model calls per workload, latency and memory use against a defined
framework baseline; do not claim savings before measurement.
