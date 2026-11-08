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
  effect fences, free-time choice, rest, self-scheduled prompts and reflection
  templates.
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
  turn: worker sweep and resume, reminder delivery, due prompts and
  templates, then free time per lane. Each part reports its own result.
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
