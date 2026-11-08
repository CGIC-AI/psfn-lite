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
storage ports for them (see Persistence). The harness, transport, bridge,
composition and Hermes packages listed below exist too; each has its own
section.

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
  effect fences, free-time choice, rest, self-scheduled prompts and reflection
  templates.
- `packages/core/src/shared` and `application`: shared primitives and the
  cross-domain use cases (ingress, turn lifecycle, dispatch, activity).
- `packages/adapters`: filesystem JSONL history and Postgres structured state.
  Model/embedding access and host capabilities are planned.
- `packages/pi`: the native conversation/activity harness.
- `packages/mcp`: the governed domain tool transport.
- `packages/lifecycle`: the lifecycle bridge an external host drives its turns
  through.
- `apps/standalone`: the thin composition for the Pi edition and the local
  core service.
- `integrations/hermes`: the native Python Hermes plugin.

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
- **Self-state** (`createEmotionService`, `createConcernService`,
  `createFollowUpService`, `createSelfStateContext`, `createSelfStateHandlers`).
  Emotion state is kept per conversation scope (`direct:<contact>`,
  `room:<channel>` or `self`). The host calls `observeTurn` after each settled
  turn.
  - Affect: one estimator call per turn. The reading is parsed strictly
    (exactly three finite axes in [-1, 1], a finite confidence in [0, 1],
    finite lowercase-label scores in [0, 1], a named producer). A malformed
    reading is reported as `unavailable` (`affect_estimator`) and records
    nothing, so observing the turn again asks the estimator again; the affect
    math throws on any non-finite number rather than clamping it. A reading
    below `trustedConfidence` is recorded as untrusted telemetry and changes
    nothing. A trusted reading
    advances the donor dynamics: per-axis half-life decay, a
    confidence-weighted impulse, then the mood and confidence EMAs.
  - Meaningful-change gate: the first trusted reading seeds the baseline.
    Drift below `appraisalThreshold` (0.35 on any axis) skips the appraisal
    model entirely. Drift at or above it records a pending appraisal in the
    same compare-and-set write as the state. That appraisal is settled only
    after a machine-authored entry is appended, so a crash or model failure
    retries it on the next observation of that turn.
  - Idempotency: each observation is keyed by turn id. Replaying a turn makes
    no estimator call.
  - Self-model: certainty, engagement, processing, trajectory and salient
    terms are derived deterministically from the turn, the affect and the
    open concerns.
  - Reads: `emotion.read` returns the estimate only when it is trusted and
    fresh (`freshForMs`) in the caller's own scope. The estimate is labelled
    `machine_inference`. Companion-authored self-reports are a separate,
    append-only record with optional `supersedes`, and appraisal summaries
    are never presented as the companion's words. Appraisals, concerns,
    follow-ups and reflections are filtered by `canViewerRead` on their
    source audience. Concerns and their evidence are also filtered by
    admitted sensitivity, and hidden items are neither counted nor hinted at.
    Lists page through the store (`collectPaged`) until enough visible rows
    are found or the store is exhausted; the stores apply the state, due-time
    and open-status predicates, so no fixed window can hide a row.
  - Concerns: they follow the donor transition matrix. Reopening requires
    new evidence. Evidence refs merge and are never dropped, and every
    revision is kept as an event. Resolving a concern records the resolution
    VAD and the relief delta, plus a machine-authored arc, and applies relief
    once per resolution generation. Affect is read and relief applied only in
    the concern's own emotion scope, from inside its conversation; resolving
    from another conversation records null affect and no relief, so one
    scope's estimate never reaches another's audience. A reopen clears the
    current resolution, but its event remains.
  - Follow-ups: they are idempotent on target, content and due time, may be
    targeted only at a conversation the viewer can read, and activate by
    compare-and-set.
  - Context: `createSelfStateContext` renders all of this as internal context
    (machine inference, authored reflection, internal signal or system note),
    never as participant speech. Each item is gated by `permitsAction`, the
    same declared-restriction check dispatch applies (admission, worker
    denial, the worker's grant), for the tool action that would read it. Authored reflections enter through the
    narrow `AuthoredReflectionPort`. `createReflectionReader` implements it
    over the journals' reflection store, and the memory composition returns
    it as `reflections`, so a reflection from free time or a template
    reaches the self-model's context in later self turns.
  - Care reminders: `concern.reminder_create` writes a once or daily
    reminder targeted like a follow-up. The scheduler delivers due reminders
    through the host's `ReminderDeliveryPort` (see Free time and automata).

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
- **Activity and automata stores** (`createPostgresActivityStores`,
  migration `0004_activity_automata.sql`).
  - Tables: `activities`, `worker_runs` (the lease end is a column, so
    recovery finds expired attempts by index), `worker_effects` (primary key
    on run and effect key: the idempotency fence; a receipt moves out of
    `started` once and is never rewritten), `rest_states` (one row per lane;
    the upsert only ever moves `until` later), `free_time_blocks`,
    `scheduled_prompts`, `reflection_templates` and `care_reminders`. A
    partial unique index (`free_time_blocks_one_open`) admits at most one
    block in `invited`, `chosen` or `executing` across every lane; a second
    is a `turn_already_open` conflict. Every
    update is compare-and-set and must advance exactly one revision. Status
    and state columns are checked against the record. Runs and blocks
    reference their activity by foreign key; nothing refers to earlier
    migrations' tables.
  - Backup: all eight tables are appended to the state backup component in
    foreign-key order (`automata-tables.ts`), and the round trip is proved in
    `tests/adapters/activity-automata.integration.test.ts`.
- **Self-state stores** (`createPostgresSelfStateStores`, migration
  `0003_self_state.sql`).
  - Tables: `emotion_states` (compare-and-set on the scope key, committed in
    one transaction with its `emotion_observations` row, so a turn is applied
    at most once), `emotion_appraisals` and `emotion_self_reports`
    (append-only, with identity ordering), and `concerns` with
    `concern_events`. Each concern revision and its event are written
    together. Follow-ups live in `follow_ups`. `concerns.status` and
    `follow_ups.state` are list predicates, checked against the record.
  - Backup: all seven tables are appended to the state backup component.
  - Migration numbering: the loader requires unique, increasing versions from
    0001 rather than contiguous ones, because parallel lanes reserve numbers.
    Applied migrations are verified by version (name and checksum), and every
    known migration not yet applied is applied in version order. A database
    migrated past a gap (for example [1, 3]) therefore receives 0002 when it
    lands instead of being stranded. This is safe only while reserved-lane
    migrations touch disjoint tables; a migration that depends on another
    takes a higher number. An unknown or edited applied migration still stops
    startup.

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

Implementation (`createActivityStack` composes all of it over explicit ports
and builds the one dispatcher that the companion and every worker use):

- **Activity** (`application/activity.ts`). Records carry purpose, status,
  outcome, artifact refs, attributed notes, the source session, turn and
  worker run, and a visibility audience. `activity.recent` and `get` show a
  record only when `canViewerRead` admits its visibility; a worker sees only
  its own run's activity. `activity.update` additionally requires the
  writer to be in the record's own conversation (the same audience), so a
  turn that can read another conversation's activity still cannot write
  into it; a mismatch reads as `not_found`. The activity that mirrors a
  worker run takes notes and artifacts from the worker or its parent, but
  its status and outcome are set only by the runner from the run's outcome
  (`worker_not_permitted` otherwise), so a worker cannot certify itself.
  Workers and free time write their status as they go, so "what have you
  been doing?" is answered without waiting for extraction.
- **Workers** (`worker-runner.ts`, `worker-session.ts`, `worker-effects.ts`).
  - Authority: `automata.spawn` validates the grant through
    `deriveWorkerScope`. It names the actions and a sensitivity ceiling no
    wider than the parent turn's, and a wider grant is refused rather than
    trimmed. Worker-denied actions (deletion, spawning, free-time choice,
    reminders) cannot be granted. Restricted memory writes from a worker are
    staged and listed by `createWorkerReview` with their run for a decision.
  - Lifecycle: the run id is derived from the conversation and the spawn key,
    so a retried spawn replays the run and a different request under the same
    key is an `idempotency_mismatch`. Its activity is written first. The host
    runs the model loop: `WorkerHostPort.start` receives a `WorkerSession`
    (the run, its scope, `beginTurn`, `call`, `finish`). Core owns the lease
    (owner and attempt), the turn budget, cancellation and the result, which
    is machine-authored and bound to the run's source audience.
  - One runner: a per-turn spawn drives the run at once, and a run queued
    for a schedule is resumed by the scheduler tick, through the same
    `drive`. Driving again requires a freshly admitted scope for the same
    audience and principal. A participant run that recovery requeued is
    driven again when its conversation calls `automata.wait` on it, or when
    the host calls `workers.resume(scope)` after admitting a turn there (a
    host obligation). One that nothing drives within `workerResumeGraceMs`
    settles as `failed` with reason `not_resumed`, mirrored into its
    activity, so no run stays queued forever.
  - Effect fences: every non-read call carries a host-supplied effect key. A
    `started` receipt is written before dispatch. An `applied` or `rejected`
    receipt replays its result, and a different request under the key is a
    mismatch. A `started` or `outcome_unknown` receipt is never executed
    again; it returns `outcome_unknown`. A failed dispatch with an
    `unavailable` outcome is recorded as `outcome_unknown`.
  - Recovery (`sweep`): an expired lease with an unsettled effect blocks the
    run as `effect_outcome_unknown`. A cancel request settles it cancelled.
    Otherwise it is requeued until `maxAttempts`, then fails as
    `lease_expired`. A run that finishes with an unsettled effect is reported
    `blocked`, never `completed`. A run another pass moved first is
    reported `contended` and left alone.
  - `automata.wait` is non-blocking: it returns the run and whether it has
    settled (driving the caller's own queued run first, as above). `message` appends bounded guidance; `inspect` shows the run and
    its effect phases, never a transcript.
- **Free time** (`free-time-service.ts`, `scheduler/free-time-gate.ts`,
  `scheduler/policy.ts`). Free time runs in the companion's own
  companion-internal turns through the host's `InternalTurnPort`, never as a
  worker.
  - Gate: `evaluateFreeTimeGate` is pure and costs no inference. In order it
    closes on rest state unavailable (fail closed), active rest, the
    quiet-hours window for that lane, an open invitation, recent partner
    activity, the minimum interval and the daily cap. Interval and cap are
    shared across lanes.
  - Invitation: a block with the fixed option menu (rest, reflect, wander,
    up to three interrupted activities to resume, begin new) is recorded
    before the companion is asked. The store holds at most one open block
    across all lanes, so when two scheduler passes overlap, the one whose
    write loses reports `invitation_open` and asks nothing; a crash leaves
    the block for the next pass to lapse or interrupt. The companion answers with `free_time.choose`, `rest` or
    `defer` inside that turn; an invented option is `invalid`.
  - Decisions: rest and defer extend rest durably through the extend-only
    `RestStatePort`, on every lane unless the companion names one. An
    unanswered invitation lapses without inventing a decision. A failed
    invitation turn records a labelled `system_failure` rest, which status
    never presents as the companion's choice.
  - Execution: a chosen activity runs in a second internal turn. A `reflect`
    reply is recorded as a companion reflection and becomes an activity
    artifact. A block left `chosen` or `executing` past its lease is marked
    `interrupted`, with its activity, and is offered for resumption instead
    of being run again.
- **Self-scheduled time** (`schedule-service.ts`). Prompts carry an explicit
  IANA zone and local time; a time skipped by DST or in the past is
  `invalid`. Prompts and reflection templates are fenced the same way: marked
  running, with its start time, before the work, so a crash leaves them
  `interrupted` and they are never repeated. A marker is read as a crash
  only once it is older than `schedulerInFlightMs`, so a run an overlapping
  pass still has in flight is left alone, and a lost compare-and-set skips
  the item (`contended`) instead of running it again. A template run requested outside a self turn, or while one
  is in flight, is deferred to the next tick. Templates call the model with
  companion-turn attribution and record a companion reflection; a run id
  replays its result.
- **Care reminders** (`care-reminder-service.ts`). A delivery is marked
  `delivering`, with its start time, before the host is asked. Only a
  definite refusal (`denied`, `invalid`, `not_found`) returns it to
  `pending`. Any other host result, `unavailable` in particular, may mean
  the message went out, so the occurrence is recorded as unknown and not
  sent again. A `delivering` marker older than `schedulerInFlightMs` is
  read as a crash and treated the same way; a younger one belongs to an
  overlapping pass and is left alone. An unknown one-off reminder ends as
  `delivery_unknown`; a daily one counts it in `unknownDeliveries` and
  moves to its next day, as a delivered one does.
- **Scheduler tick** (`scheduler-tick.ts`). One pass in a companion-internal
  turn: worker sweep, resume, then settling queued runs past their grace
  window (after resume, so scheduled runs queued through an outage are
  driven first), reminder delivery, due prompts and templates, then free
  time per lane. Each part reports its own result.
  There is no tick-wide lock: each step is exclusive on its own (the
  one-open-block index, compare-and-set on every in-flight marker, age-gated
  stranded markers), so overlapping ticks, on one host or several, neither
  invite, deliver nor run anything twice. With
  nothing due and rest in force, a tick makes no model call and opens no
  turn; the tests count inference across ticks
  (`tests/core/free-time.test.ts`).

## Host responsibility and Hermes

The host owns credential custody, execution isolation, approvals, provider
access, channel delivery and practical tools. The core owns contact/audience
authorization, memory disclosure, continuity and authorship. Module separation
alone is not a sandbox for host shell execution.

Use Hermes native integration for lifecycle, identity, context and activity
execution; use MCP for the tool transport where appropriate. The section
Lifecycle bridge and Hermes integration describes how this is built. Verify available
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

## Memory, episodes and journals

`createMemoryStack` (`packages/core/src/application/memory-composition.ts`)
composes the `memory`, `episode` and `journal` tool handlers, the maintenance
pass and the operator administration from explicit ports. Hosts merge its
handlers with `createContinuityHandlers` before building the dispatcher. No
port has an in-memory fallback, and nothing depends on a wiki.

- **Access is data.** `sourceAccessFor` turns a viewer into a `SourceAccess`:
  admitted sensitivities, readable source classes, own conversations, whether
  self material is readable, and a subject binding. A participant reads only
  memories about themselves or their room, and companion-internal memories
  only from self turns (the donor's mandatory subject authorization). The
  Postgres stores render the same predicate in SQL and apply it before
  ranking, limits and counts, so withheld rows never shape results, census
  totals or neighbour lists. A withheld id reads as `not_found` on every
  read and write path. A test proves the predicate equals `canViewerRead`,
  and an integration test proves the SQL equals the core predicates.
- **Authorship.** Each memory records its author and attribution:
  `companion_authored`, `participant_attributed` (bound to the speaking
  contact), or `inferred` (with the producer). Workers and extraction write
  only `inferred` or `participant_attributed`. A rewrite by the companion
  becomes `companion_authored`, and the patch event keeps the previous text
  and attribution.
- **Writes and evolution.** One writer serves tool writes, imports and
  extraction. Each write has an idempotency key; keys are namespaced by
  conversation. A retry with the same content replays the receipt (same id,
  same provenance), and a reused key with other content is an
  `idempotency_mismatch`. A write is compared only with memories its own
  conversation may read, by the donor's dedup thresholds and reconciliation.
  A destructive supersede is allowed only when the incoming attribution has
  at least the existing one's authority; otherwise it is recorded as a
  conflict link. A near-identical write deduplicates only into a memory of
  at least its own authority. A companion-authored or participant-attributed
  write that matches an inference becomes a new record that supersedes it,
  so the inference survives only as superseded history. Worker writes of boundary or relational kinds, or of
  intimate or confidential material, are staged until an operator reviews
  them. Deletion is a proposal through `ApprovalPort`; only operator
  administration applies it, as a reversible soft delete.
- **Extraction** runs only in a companion-internal maintenance turn, after a
  per-session watermark. The model proposes; the runtime binds each subject
  to the attributed speaker of the named turn and records nothing about a
  contact without granted consent, nor anything drawn from such a contact's
  own turn, whatever the subject (a group item about the room included).
  Each write key covers every field of the writer's request digest, so a
  rerun that relabels an item is a new write that deduplication resolves,
  not a key mismatch that stalls the watermark. Malformed output fails the
  session and keeps the watermark.
- **Episodes** form only from ended conversations: no longer active, or idle
  for `endedAfterMs`. A long pause splits a session. A short exchange becomes
  a `brief` episode with deterministic signals and no model call. Ranges
  without conversation are reported. Episode ids derive from the session and
  archive position, so a rerun returns the same episodes. Meaning is written
  only by the companion in a self turn, compare-and-set, and every version is
  kept. Meaning is companion-private: only readers that may read self
  material see it, everyone else gets the machine draft with no sign that
  meaning exists, and it is neither indexed for search nor embedded.
  Consolidation never merges, absorbs into or re-summarizes an episode that
  has meaning. Writing meaning moves the episode revision, the store refuses
  any machine change but promotion to an episode with meaning, and a merge is
  one compare-and-set transaction over the survivor and every absorbed
  episode, so neither a race with the companion nor a retry after a failure
  merges anything twice or hides what the companion wrote. An arc is shown
  only when every member is readable.
- **Search** is hybrid. Lexical full-text and pgvector cosine results are
  fused by reciprocal rank, and each response reports which modes worked. An
  embedding that fails marks the write `pending`, and the maintenance
  backfill embeds it later.
- **Journals, reflections and letters.** Note provenance is stamped from the
  writing scope: the source conversation, or `restricted` for self turns and
  for notes merged across conversations. A restricted note is readable only
  where confidential material is admitted. A reflection is either the
  companion's own (only from its internal turn) or a process log. Letter
  composition is idempotent by id, every transition is a recorded event, and
  the Partner's drafts are never shown.
- **Maintenance** (`createMemoryMaintenance`) runs extraction and episode
  formation per recent session, then consolidation per conversation, arc
  weaving and the embedding backfill. Each failure is reported with its
  error, and its watermark stays put for the next run.

Storage (`openPostgresMemoryState`, `postgresMemoryStores`) uses migration
`0002_memory_state.sql`. Records are JSONB in core's shape. Columns hold keys,
revisions and the access-filter fields. No column is generated, so a backup
restores by plain insert. Embeddings are rows per named space with declared
dimensions, checked per row. Opening the stores for a space creates its
partial HNSW cosine index on each embedding table. Semantic queries order by
the indexed expression and use pgvector's iterative scan, so a filtered search
still fills its limit. A space reopened with different dimensions fails to
open. The new tables are appended to the structured-state backup in
foreign-key order. Embeddings are backed up as rows, and the indexes are
rebuilt when the stores open.

Known limits:

- The soft delete and the proposal decision are separate port calls. If
  saving the decision fails after the soft delete, the memory is soft-deleted
  while its proposal stays pending. Repeating the decision then reports a
  conflict, and `restore` still works. Likewise, `propose_delete` submits the
  approval before it stores the proposal, so a retry after a failed store
  submits a second approval.
- A journal write to a path held by a note this conversation cannot read
  returns `not_found`. That differs from a fresh create, so it reveals that
  the path is taken.
- Letter ids are one namespace shared by the companion and the Partner.

## MCP transport

`packages/mcp` (package `lite-mcp`, public entry `src/index.ts`) exposes the
inventory to external harnesses over the MCP SDK (`@modelcontextprotocol/server`
2.3.0). It is a transport, not a host: it adds no handlers, authorization or
argument validation, and it opens no turns. `tests/boundary/mcp-imports.test.ts`
enforces that it reaches core only through `core/src/index.ts` (via its own
`src/core.ts`) and the adapters only through `adapters/src/index.ts`, imports
only `node:` builtins and its exact-pinned SDK, and that neither core nor the
adapters reference it.

- **Tool surface** (`createMcpSurface`, `buildToolCatalog`). One MCP tool per
  inventory tool, named as the inventory names it, with an `action`
  discriminator whose values are the inventory's actions. Descriptions,
  read-only hints and the per-action `_meta` (`psfn-lite/actions`: access,
  privacy, admission, restrictions, worker access, inference) come from
  `TOOL_INVENTORY`. Argument properties come from `ACTION_ARGUMENTS`, because
  the inventory carries no argument shapes; `tests/mcp/argument-drift.test.ts`
  reads the `withArgs` key lists from `application/handlers-*.ts` and fails if
  any action's described keys differ. The schema requires only `action` and
  leaves the property set open, so an unknown or authority-shaped argument
  reaches core and is refused there (`unknown arguments`, `authority cannot be
  passed as arguments`), not filtered in transport. A catalog that misses an
  inventory action, or describes one the inventory lacks, refuses to build.
- **Caller binding.** Transport credential, then operator binding, then core
  ingress. `loadPrincipalBindings(config, env)` reads a configuration of
  `{ principal, credential: { env } | { file }, attestation }` entries; the
  configuration names where a credential lives and never holds one. A file
  must be a regular file readable only by its owner. A credential must be
  32-4096 printable characters and is kept only as a SHA-256 digest; startup
  fails on a weak, missing or reused credential or a principal bound twice.
  The attestation fixes surface, principal (a channel identity), room and
  turn kind. A `companion_internal` principal is refused at startup: a
  self-audience scope admits every sensitivity and every conversation's
  sources, so no standing credential may reach it (see internal turns below).
  The returned `authenticator` is the `CallerAuthenticatorPort` the host
  builds MCP's `createTrustedIngress` with; it accepts only
  `{ kind: 'mcp_credential', credential }` and answers with the bound
  attestation. Every tool call is admitted again (`ingress.admit`), so a
  contact that is blocked, unblocked or loses consent changes what its next
  call may do on the same connection. A binding to an identity core does not
  know is unknown authority, and a channel account bound to a self room is
  refused by ingress. Credentials are matched by hashing the candidate and
  comparing it with every digest in constant time, without early exit.
- **Internal turns** (`createMcpInternalTurns`, `combineCallers`). The
  companion's own tools (reflections, letters, episode meaning, free time) are
  reached only inside a companion-internal turn core asked for. The host
  implements core's `InternalTurnPort` with `createTurnPort(launch)`: each
  `run(request)` mints a random credential, calls `launch(request,
  credential)` so the host's harness connects its MCP client with it (as its
  bearer, never in the prompt or arguments), and revokes it when the run
  settles, whether it completed, failed or threw. The credential's
  attestation is derived from the request (the turn's purpose, the surface of
  the scope core admitted, self room, background); the purpose is the
  request's, because core runs some turns under a scope admitted for another
  purpose (a scheduler tick's scope runs scheduled prompts). A request whose
  scope is not an ingress-admitted companion-internal self scope mints
  nothing. A credential also expires after `ttlMs` while its turn is
  still running, and at most `maxOpen` turns hold one; another turn is then
  refused as `unavailable` rather than evicting a live one. The host builds
  ingress and the HTTP transport with `combineCallers(bindings,
  internalTurns)`, so both the pre-body 401 check and ingress recognize a
  live turn credential. The credential is bound to the turn by lifetime:
  ingress admits each call and mints a fresh scope from the attestation,
  not the scope object in the request. stdio carries participants only,
  since the harness launches the stdio server process and no host there
  mints turn credentials.
- **Results.** A success returns `{ origin: tool_result, content }` as
  structured content and JSON text, so a harness labels it tool output. A
  failure returns `isError` with core's error: `denied` (reason and detail),
  `not_found` (subject), `conflict`, `invalid` (issues). An `unavailable`
  detail can carry driver text, so the client receives only the capability
  and a fixed message; the operator's `onError` receives the original. A
  thrown failure becomes a generic `unavailable` the same way. An unknown tool
  is a protocol error (`Tool <name> not found`).
- **Streamable HTTP** (`startMcpHttpServer`). Binds `127.0.0.1` unless the
  operator passes `exposeBeyondLoopback` with the Host values to serve; a
  loopback endpoint answers only loopback Host headers (DNS rebinding). Each
  POST is authenticated before its body is read (401 with
  `WWW-Authenticate: Bearer`, the same text for every refusal), and is served
  by a fresh protocol server through the SDK's stateless `createMcpHandler`,
  so no transport session carries authority between requests. Requests with
  an `Origin` (browsers) or `Mcp-Session-Id` are refused, other methods get
  405, bodies over `maxBodyBytes` (1 MiB) get 413, and `Authorization`,
  `Cookie` and `Proxy-Authorization` are stripped before the SDK sees the
  request. Both 2026-era and 2025-era (`initialize`) clients are served.
- **stdio** (`startMcpStdioServer`). The launching operator supplies the
  process's credential from the environment or a private file; an unbound
  one stops startup with `unknown_authority` and is never echoed. Calls on the
  connection are still admitted one by one.

Tests: `tests/mcp/inventory-parity.test.ts` lists the tools through the SDK
client and calls every inventory action over a real HTTP connection (every
companion-only action from inside an internal turn under its minted
credential, free-time choice from the scheduler's own turn);
`internal-turns.test.ts` covers standing credentials reaching no private
state, revocation on settle, TTL expiry, the open-turn bound, refusal to
mint for any other scope, and a scheduled prompt served in the tick's turn;
`authority.test.ts` and `leakage.test.ts` cover unknown, untracked, blocked and
background authority, identity in arguments, cross-audience reads and counts,
companion-private state, credential non-disclosure and error redaction;
`stdio.test.ts` drives a real child process; `postgres.integration.test.ts`
runs the surface over the Postgres stores.

Host duties MCP does not take on: it is not lifecycle integration. It does not
call `prepareTurn`/`commitTurn`, observe turns for emotion, or call
`workers.resume(scope)`; the harness that admits participant turns keeps that
duty (an `automata.wait` over MCP still drives the caller's own queued run).
Actions that bind to the current turn (`activity.start`) use the session and
open turn the durable state records for the caller's audience.

## Pi harness and standalone composition

This section covers `packages/pi` and `apps/standalone`. The MCP transport,
the lifecycle bridge and the Hermes plugin have their own sections.

`packages/pi` (package `lite-pi`) is the native harness. It runs on the
public API of `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
(both pinned at 0.84.1, the donor's versions): `runAgentLoop` with its
`shouldStopAfterTurn` and steering hooks, and pi-ai's model collection. It
does not use the `Agent` class, does not patch Pi internals and keeps no Pi
session between turns. `src/pi.ts` is the only module that imports Pi, and
`src/core.ts` is the only one that reaches core (through its public entry).
The model, the provider key and the output ceiling are host-supplied as a
`PiModelRuntime`. A catalogue runtime uses an auth context that answers
nothing, so pi-ai never discovers a credential on its own: no provider
variable from the environment and no credential file. The explicit key is
the only credential a request carries, and with none only a keyless provider
can serve it.

Every turn follows core's lifecycle:

1. **Prepare.** Ingress admits the host's evidence. The session's current
   revision is read. Core's turn context assembler (`createTurnContextAssembler`,
   shared with external hosts) builds the context only from core reads under
   the turn's scope: enabled prompt layers, the conversation's orientation
   blocks (none for self turns), the labelled self-state context, recent
   activity, and canonical history through `contextFromHistory`. Recent
   activity is shown only when `activity.recent` itself would be permitted,
   and only the records `canSeeActivity` admits for this audience. It is one
   labelled `internal_signal` entry that says whether each activity happened
   in this conversation, in another one or in the companion's own time. Then
   `prepareTurn` opens the turn.
   A stale revision is retried. An open turn of this harness that is not
   running in this process is settled first: with the outcome the harness
   holds for it, or else as interrupted by the host with delivery `unknown`.
   A turn left open by another owner is recovered through `recoverTurn` only
   after its lease, so the recovery is attributed to the host. A replayed key
   returns the recorded settlement without calling the model. A repeated key
   whose turn is still open never runs the turn again: it records the held
   outcome or the abandoned one.
2. **Execute.** The model loop sees one Pi tool per domain tool of
   `TOOL_INVENTORY`. Each takes `{action, args}` with the actions as an enum.
   Every call goes through core's dispatcher under the turn's scope. A
   refused call becomes a labelled error result for the model. The loop has
   a model-call budget per turn and a bounded tool-result size.
3. **Record.** A completed reply is delivered (participant turns only) and
   then committed with its delivery status. An aborted, failed or stopped
   loop is aborted with who interrupted (`participant`, `shutdown`, `host`)
   or the failure code. Any partial reply is kept, so the system note in
   history says what happened. A transient settlement failure is retried a
   bounded number of times with the same outcome. An outcome that still
   cannot be written is held in memory and recorded by a retry of the
   request or by the session's next turn. A throwing delivery port is
   recorded as delivery `unknown`.
4. **Post-turn.** The settled turn is observed for emotion
   (`emotion.observeTurn`). In participant turns the conversation's requeued
   workers are resumed (`workers.resume`).

Only companion speech is rendered in the assistant position. In the user
position every block starts with a label line: `[participant speech]` for
what a participant said, and core's label for system notes, tool results and
machine inference. A line of text that starts with `[` is escaped as `\[`,
so neither a participant nor labelled content can forge a label, and merged
user messages keep every block boundary visible.

Host ports implemented over Pi:

- `InternalTurnPort`: free time, scheduled prompts and reflection templates
  run as companion-internal turns of the same harness, keyed by the
  reference and the prompt.
- `WorkerHostPort`: a worker runs inline with only its granted actions. Each
  model turn starts through `WorkerSession.beginTurn`, so core enforces the
  turn budget and delivers new guidance (injected as labelled steering).
  Effects are keyed per attempt and by a digest of the tool call id (provider
  ids may hold characters core refuses in a key). Cancellation aborts the
  loop. On shutdown the host refuses new attempts and aborts running ones,
  each reported as `cancelled` with reason `host_shutdown`.
- `ModelPort` and `AffectEstimatorPort`: machine tasks over the same model.
  A provider error or a non-JSON estimate is `unavailable`, never an empty
  success, and core re-validates every estimate.
- `EmbeddingPort`: pi-ai has no embeddings API. It is either explicitly
  disabled (writes stay pending for the backfill) or an OpenAI-compatible
  endpoint with strict dimension checks.

`apps/standalone` (package `lite-standalone`) is the thin composition root.
It takes one explicit configuration document: every setting is required,
unknown keys are refused, and policies are the core baseline only when named
`"baseline"`. Secrets are read from the environment variables the document
names, and a missing one is reported by name only. It opens the storage
layout, the JSONL archive and one migrated Postgres pool. It builds every core
stack, wires the Pi harness, and runs the scheduler tick loop with memory
maintenance every Nth tick. The CLI has `init`, `once`, `chat`, `tick` and
`maintain` (`npm run standalone -- <command> --config <file>`, run through
tsx because core uses TypeScript parameter properties). `serve` runs the
scheduler and the configured transports until Ctrl-C. `createLiteRuntime` is
the composition entry. It exposes the governed dispatcher and ingress, and it
mounts the MCP transport and the lifecycle bridge when the config names them
(see Lifecycle bridge and Hermes integration). The local host vouches for exactly two callers:
the configured operator in their direct conversation and the companion's own
internal turns. Its evidence is an opaque object minted in-process. `close`
first refuses new work and interrupts every turn as `shutdown`, including
turns still preparing and the scheduler's own turns, and cancels running
worker attempts. Then it stops the scheduler, waits for all of it to settle
and closes storage.

Known gaps:

- No approval queue: protected changes that need approval are refused with
  `unavailable (approval_queue)`.
- Workers run inline within the turn that drives them. There is no separate
  worker process.
- Rooms with several speakers get no per-speaker labels yet. Standalone has
  only the direct operator conversation.
- Only pi-ai's builtin providers can be configured. A provider is chosen by
  id and model id from pi-ai's catalogue.

## Lifecycle bridge and Hermes integration

An external companion host (Hermes, `integrations/hermes`) runs its own model
loop. It reaches Lite through two loopback surfaces that the standalone
runtime mounts when its config names them. Both are bound from the same
operator credentials:

- the MCP transport, for the governed tools;
- the lifecycle bridge (`packages/lifecycle`, package `lite-lifecycle`), for
  the turn lifecycle.

The config has two required-nullable blocks:

- `mcp`: `host`, `port`, `allowedHosts`, `bindings` (the binding document
  `loadPrincipalBindings` reads, naming credential variables or files, never
  values), `internalTurnTtlMs` and `maxOpenInternalTurns`.
- `lifecycle`: `host`, `port`, `allowedHosts` and `internalTurns`. The
  bridge needs `mcp`.

Callers are recognised in this order: the CLI's in-process evidence first,
then the bindings, then the credential minted for one internal turn
(`combineCallers`). One core ingress admits all of them.
`tests/boundary/harness-imports.test.ts` enforces that the bridge reaches core
and MCP only through their public entries (via `src/core.ts` and `src/mcp.ts`),
that it has no third-party dependency, and that core references neither MCP
nor the bridge.

### Bridge

The bridge serves `POST /lifecycle/v1/<route>` with JSON bodies. The bearer
credential is identified before the body is read. Browser origins and
unexpected Host headers are refused, and bodies are parsed strictly: unknown
fields are refused, and no field names a caller, contact, audience or
speaker. Each route calls one core use case in `application/hosted-turns.ts`
and holds no logic of its own:

- `prepare {hostInstance, idempotencyKey, message}` calls
  `HostedTurns.prepare`. It opens a turn in the caller's current session for
  the admitted participant. The context is assembled against the session
  revision, and a stale revision is retried. A repeated key whose turn is
  open resumes it (`resumed: true`), with the history before its trigger; a
  settled key replays its outcome. The turn owner is the bound principal,
  narrowed by the host's process instance. Another owner's open turn is
  recovered only after its lease. This owner's own open turn is refused as
  `turn_already_open`, because it may still be running. The response is
  core's context with each entry's role, label, origin and (for history)
  turn id, so the host renders attribution exactly.
- `settle {hostInstance, turnId, outcome, toolCallCount}` calls
  `HostedTurns.settle`. It handles `completed`, `interrupted` and `failed`
  outcomes, with the actual reply or partial reply and delivery. Only a turn
  of the admitted audience is visible, and only its owner settles it. Then
  the post-turn work runs: `emotion.observeTurn`, and `workers.resume` for
  participant turns. Each part reports its own failure. Settling again with
  the same outcome repairs history and does not run post-turn work twice.
- `checkpoint {turnIds}` calls `HostedTurns.checkpoint`. The host calls it
  before it compacts its own transcript. For each named turn of the audience
  it re-appends the ledger-derived entries (identical entries are no-ops),
  which both proves and repairs canonical history. It answers which turns are
  settled and which are open. A missing turn, or one of another audience,
  refuses the whole checkpoint. Compaction never touches the Lite archive,
  which stays the source of evidence.
- `internal/claim {waitMs}` and `internal/release {jobId, error}` serve
  delegated internal turns (below).

Failures keep core's public error shape (`publicError`) with status 400, 403,
404, 409 or 503. Unavailable failures, failed post-turn work and released
internal turns are also reported to the operator as `transport`
diagnostics.

### Internal turns

`lifecycle.internalTurns` is either `{"kind": "harness"}`, where the Pi
harness runs core's internal turns in-process as before, or
`{"kind": "delegated", host, claimTimeoutMs, runTimeoutMs}`. In delegated
mode core's `InternalTurnPort` is the MCP internal-turn credentials over a
queue (`createDelegatedInternalTurns`). For each request a credential is
minted, and only the named bound principal may claim the request. The claim
hands over the minted credential, the purpose and the prompt. A `prepare`
made with that credential ignores the body's key and message: core's request
fixes the trigger, as a `system_note` origin, never participant speech, and
the key, which is the same one the Pi harness derives. The turn is owned by
the job, and its settlement completes core's request.

If nobody claims the request within `claimTimeoutMs`, it resolves as
`unavailable (internal_turn_host)`. A claimed turn that is not settled within
`runTimeoutMs` (at most the credential's lifetime), a released job, and
shutdown all settle the job's open turn as failed and report it. Worker runs
stay on the runtime's Pi worker host.

### Hermes plugin

`integrations/hermes/psfn_lite` is a Hermes memory-slot plugin, tested
against Hermes `f0187332d13679e2ace74d1f0eb399eb91a90571`. It registers
`pre_llm_call`, `pre_tool_call`, `post_llm_call`, `post_tool_call`,
`on_session_end`, `on_session_finalize` and `subagent_start` once per
process, plus a memory provider with no tools and no recall:

1. **Prepare.** Each root turn of a bound sender is prepared under
   `hermes:<sha256(session, turn)>`. A prepare whose answer was lost is sent
   once more under the same key, which Lite resumes. Lite's context is
   injected into the user message as labelled blocks with the same label
   escaping as the Pi harness.
2. **Settle.** `on_session_end` settles the turn as completed with the reply,
   interrupted, or failed. Open turns are keyed by Hermes's turn id, which
   survives a compression's mid-turn session rotation. Hermes fires
   `on_session_end` only from `finalize_turn`, and several failure paths in
   `agent/conversation_loop.py` return before it. A turn left open that way
   is settled as failed (`hermes_turn_unfinished`) before the next turn of
   the same conversation is prepared, or when Hermes finalizes the session.
3. **Gate.** Hermes's MCP client sends the profile's standing credential on
   every call, so `pre_tool_call` blocks the Lite tools outside an open Lite
   turn of the process. That covers unbound senders, subagents, the review
   fork, cron and flush agents, and a profile where the plugin is not usable.
4. **Checkpoint.** Before compaction the provider calls `checkpoint`
   (checkpoint API v2) and raises when Lite cannot prove the session's turns.
   With `compression.checkpoint_required`, Hermes then keeps the
   uncompressed transcript.

Unless Hermes's own memory stores are off and compaction is fail-closed, the
provider refuses to start, and the hooks refuse to drive any Lite turn and say
so. Hermes only logs a provider that fails to start, so the hooks enforce
this themselves. This keeps one authoritative memory per profile.
Subagent sessions (seen through `subagent_start` or their `subagent` platform), the background review fork, and cron or flush agents never become Lite turns.

Every event Lite did not accept is logged, kept in an owner-only SQLite
ledger in the profile, reported through the warning callback, and named in
the next turn's context. Each Lite turn has a ledger row from before its
prepare until Lite accepts its settlement. A kept settlement is retried
before the next turn and blocks compaction until Lite has it. When the turn's
id was never learned, the retry prepares the kept key again first. The next
standing process of the profile settles the turns of an exited process as
failed (`hermes_process_ended`) under that process's host instance.

In delegated mode the process started with `PSFN_LITE_INTERNAL_HOST=1`
claims internal turns. It runs each one as its own Hermes process with the
minted credential, so that turn's MCP tools act in the companion's self
audience. Inside that process the root-turn guard still applies, so a
subagent or the review fork never prepares or settles the job's turn.

Known gaps: Hermes reports no partial reply for an interrupted or failed
turn, and it delivers the reply after the hook, so delivery is recorded as
`unknown`. Turns from senders outside the plugin's `senders` list are not
recorded. They are told so in their context.

Proof:

- `tests/lifecycle/bridge.integration.test.ts` runs the standalone runtime
  over Postgres. It covers credential binding, every outcome under stable
  entry ids, resumption, checkpoints, cross-conversation activity disclosed
  to the operator and not to a regular contact, MCP on the same runtime, and
  delegated internal turns, including a release that fails visibly.
- `integrations/hermes/tests` runs host contract tests inside the pinned
  Hermes, and an end-to-end suite that drives Hermes's real MCP client and the
  plugin against that runtime (`tests/hermes/fixtures/lite-host.ts`).

