# Architecture and extraction decisions

Status: agreed direction from the founding design conversation; implementation
details must be demonstrated against source and contract tests.

## Two product parts

The persistent companion core owns identity and continuity. The replaceable
harness owns execution of a conversation or activity. Pi is the native harness;
Hermes is the only alternate integration target in the initial scope.

Module layout. `packages/core` exists (package `lite-core`, public entry
`src/index.ts`) with each domain's types, core-owned ports and tool descriptor,
plus the application boundary described below. The identity, sessions and
contacts actions have domain services wired into dispatch; other domains have
contracts only. `packages/adapters` (package `lite-adapters`) implements the
storage ports for them (see Persistence). Every other package is planned.

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
- `packages/adapters`: filesystem JSONL history and Postgres structured state.
  Model/embedding access and host capabilities are planned.
- Planned: `packages/pi` (the native conversation/activity harness),
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
Storage adapters implement the domain ports outside core. Core contains no
storage and no in-memory fallback, and no core interface names a concrete
adapter.

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
  ones with delivery status and any partial reply. The ledger write fixes the
  outcome first and history is derived from the settled record, so the archive
  never shows a reply the ledger did not record. A failed append is returned as a
  failure and repaired by retrying the same outcome or replaying the request; a
  different outcome after settlement is a conflict. The archive rejects an entry
  id that already exists with different content. A replayed request re-appends
  its turn's entries before the ownership check, so a successor that is refused
  as `turn_ownership` still repairs the history. Before opening a new turn,
  `prepareTurn` re-appends the entries of the session's last settled turn
  (`TurnLedgerPort.lastSettled`) and opens nothing if that fails. A crash
  between ledger settlement and the history append is therefore repaired by
  whichever harness opens the next turn, and only the latest settlement can lag
  history.
  Each open turn carries a lease (`turnLeaseMs`, required). While the lease runs
  only the owning harness instance may settle the turn, and a live owner hands
  over through `abortTurn`. After it expires, a successor with a scope for the
  same audience calls `recoverTurn`. That records the turn as interrupted by the
  host, together with who recovered it, and the original owner's late settlement
  becomes a conflict. An idempotency key replays a settled turn instead of
  re-executing, and reuse with a different request is a conflict.
- **Worker scopes** (`deriveWorkerScope`) narrow a participant or internal scope
  for a bounded worker. The grant names its actions, a positive turn budget and a
  `maxSensitivity`; the worker is admitted only up to that ceiling, never the
  parent's full ceiling. Unknown or worker-closed actions, actions above the
  ceiling and ceilings the parent lacks are refused, not trimmed.
- **Dispatch** (`createToolDispatcher`) resolves `tool.action` against the
  inventory, enforces admission, `foreground_only`, `self_audience_only` and
  worker grants, then calls the owning domain handler. A missing handler is
  `unavailable`, never a silent no-op. Results are attributed as tool output.
- **Activity** (`createActivityService`) records purpose, status, outcome,
  artifacts and attributed notes bound to the source turn and audience. Another
  audience's activity reads as missing.
- **Sessions** (`createSessionService`). A session is bound to one audience
  when it is created. `prepareTurn` refuses a turn whose scope has another
  audience, so a session id never mixes rooms. Reads follow `canViewerRead`.
  A room's disclosure class is confidential for direct and self rooms,
  personal for small groups and public for large rooms and broadcasts.
  Self-audience history is readable only from self turns. A non-worker always
  reads its own conversation. Anything else needs the class admitted, and a
  worker also stays under its grant's ceiling. `new` records lineage
  (`previousSessionId`). `resume` of another audience's session starts a
  continuation (`continuesFrom`) instead of moving the caller into that room.
  Search is served from the Postgres projection only after it is proven level
  with the canon: same entry count and chain hash. A projection that is ahead
  or diverged is reset and rebuilt from the JSONL. Model summaries are
  attributed as machine inference, never as companion speech.
- **Contacts** (`createContactService`, `createContactAdministration`,
  `createContactAuthority`). Ingress resolves a verified identity through the
  store and follows merges for at most eight hops. A missing target or a cycle
  is unknown authority. An archived contact is unknown, and so is a merged
  contact that has no survivor. A blocked contact is blocked, and any consent
  other than `granted` is untracked. A merge never widens authority. The
  survivor takes the lower trust, the more restrictive consent and the higher
  sensitivity, and it is blocked if either side was. Identities move to the
  survivor in one transaction. Raising trust to trusted or above, family and
  partner relationships, and linking an identity onto a high-tier contact
  become approval proposals. Every write is audited with its author.
  Tracking consent also gates the dossier, not only ingress. For a contact
  whose consent is pending, denied or revoked, `note`, `link_identity`,
  `set_trust`, `propose_trust`, `set_relationship`, `propose_relationship`,
  `set_channel_privacy` and `set_machine_intelligence` are denied as
  `untracked_contact`, and `lookup` withholds its notes. Block and unblock stay
  available, because blocking protects and does not profile.
- **Identity** (`createOrientationService`, `createIdentityAdministration`,
  `createValuesService`). Orientation blocks are kept per conversation with
  compare-and-set revisions, and limits reject instead of truncating. Prompt
  layers and the persona card are append-only versions. A worker reads a
  conversation's blocks only when its grant admits that conversation's
  disclosure class (`canViewerRead`), the same rule as for its history. Protected layers
  (base, operator) and protected persona fields become proposals, which apply
  only if the version and checksum have not moved. Values append revisions.
  The North Star holds at most three active items, and every item version is
  kept.

Failure semantics are types (`shared/result.ts`): every operation returns a
`Result` whose failures are `denied`, `not_found` (also used for items the
audience may not see), `conflict` (stale revision, turn ownership, open or
settled turn, active lease, idempotency mismatch, archive entry mismatch,
existing record, identity owned by another contact, with expected/actual
revisions), `invalid`
or `unavailable`. Internal context carries one of seven origins (participant
speech, companion speech, tool result, system note, internal signal, machine
inference, authored reflection). Only participant speech renders in the
participant role, and only an admitted participant scope can produce it.

Pi and Hermes enter the same way with no service locator or universal options
object. Each host authenticates its caller, then calls `ingress.admit`, then
`prepareTurn`, `dispatcher.dispatch` for every tool call, and finally `commitTurn`
or `abortTurn`. A host that restarts or takes over a session calls `recoverTurn`
for a turn its predecessor left open. A tool transport such as MCP maps calls to `dispatch`; the Hermes
native plugin maps its lifecycle hooks to prepare/commit/abort. Each use case
takes only the ports it needs, and both surfaces share one inventory and one set
of handlers.

## Persistence

`packages/adapters` implements core-owned ports. It contains no policy.
`tests/boundary/adapter-imports.test.ts` enforces that an adapter reaches core
only through `packages/core/src/index.ts`, and imports only `node:` builtins
and its declared, exact-pinned dependencies (`pg`). It also checks that core
never references the adapters.

- **Storage layout** (`resolveStorageLayout`). The roots are canonical
  history, the agent workspace, and optionally credentials and backups. Each
  root is resolved through symlinks, and the layout is rejected if any two
  roots are equal or nested. Only a resolved layout opens the archive or a
  backup store, and backup sets live only directly under `backupRoot`. As a
  result, a workspace cleanup or a harness reset cannot reach lived history,
  and history never sits beside credentials. Database connection strings are
  passed in by the host. They are never stored in a root and never appear in
  an error.
- **Canonical history** (`openFileSessionArchive`). History is one JSONL file
  per session under `<historyRoot>/sessions/`. Each line carries
  `seq`, `prev` and `hash = sha256(prev + canonical(entry))`.
  - Appends: each append is one write followed by fsync, serialized per
    session. Re-appending an entry id with identical content is a no-op. With
    different content it is an `entry_mismatch` conflict, and nothing is
    written.
  - Opening: an unterminated trailing fragment (a torn append) is quarantined
    to a `.torn-*` file and the verified prefix is kept. A session that fails
    verification for any other reason is refused as `unavailable`, and the
    other sessions keep working.
  - Locking: an exclusive lock file guards the root. A lock left by a dead
    process is taken over. So is a lock carrying this process's own pid that
    this process does not hold, which is what a restarted container leaves
    when the app is pid 1 again. A second open in the same process is still
    refused.
- **Structured state** (`openPostgresState`) uses Postgres with pgvector.
  - Migrations: versioned `NNNN_name.sql` files run under an advisory lock,
    one transaction each. Checksums are recorded in `schema_migrations` and
    re-verified on every start. An edited, missing or unknown applied
    migration stops startup.
  - Stores: the stores implement the turn ledger, session catalog, continuity
    notes, focus records, transcript projection, contacts (with identity
    index, audit log and notes), orientation blocks, prompt layers, persona,
    values and North Star. Records are JSONB documents in core's shape.
    Columns exist only for keys, ordering and the constraints the database
    must enforce: compare-and-set under row locks, version primary keys, and
    one contact per channel identity.
  - Projection: the transcript projection (`tsvector`, `simple`
    configuration) is derived from the canon and records the archive head it
    reflects.
- **Backup** (`createContinuityBackup` in core).
  - Components: the set of components is fixed when the backup is created.
    Lite has two. The history component copies verified chains, and its
    fingerprint is the session heads. The state component exports every
    durable table from one repeatable-read snapshot, in primary-key order,
    together with the schema version. It leaves out the projection, which is
    rebuilt after restore.
  - Writing: each file in a set is written atomically and exclusively, so a
    set is never partially overwritten. `openFileBackupStore(layout, setName)`
    requires a resolved layout with a `backupRoot` and a single-segment set
    name, and it refuses a set directory that resolves anywhere else (for
    example through a planted symlink). A full copy of private state can
    therefore never land in the workspace or beside history.
  - Consistency: every component is fingerprinted before the first export and
    again after the last one. A write that lands between two components'
    exports fails the backup as `stale_revision`. Without this, a set could
    hold a ledger turn whose history is missing.
  - Time zones: the state component pins `TimeZone` to UTC in every snapshot
    and import transaction, so its fingerprint does not depend on the
    server's, database's or role's zone.
  - Restore: every digest is verified before anything is written. Restore
    targets only an empty history root and an empty database at the same
    schema version. Each component proves the backup fingerprint before its
    content becomes durable. The state component recomputes it inside the
    import transaction and rolls back on a mismatch. The history component
    verifies every backed-up chain and the fingerprint before it installs the
    first session. A fingerprint mismatch in either component leaves that
    target empty and the restore retryable. An I/O failure partway through
    installing history sessions does not. Core then recomputes each fingerprint once more. The two
    components are still separate stores, so an I/O failure in the second
    after the first committed leaves the first restored.
  - A component that changes during the backup fails it, and the writers must
    be quiesced before retrying.

Integration tests (`*.integration.test.ts`, part of `npx vitest run`) run
against a throwaway pgvector container. The container uses a pinned image
digest, a random name and port, a tmpfs data directory and a label, and it is
always removed (`tests/support/postgres-harness.ts`). The tests fail when
Docker is unavailable. `LITE_SKIP_DOCKER_TESTS=1` is the explicit, printed
opt-out.

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
