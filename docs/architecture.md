# Architecture and extraction decisions

Status: agreed direction from the founding design conversation; implementation
details must be demonstrated against source and contract tests.

## Two product parts

The persistent companion core owns identity and continuity. The replaceable
harness owns execution of a conversation or activity. Pi is the native harness;
Hermes is the only alternate integration target in the initial scope.

Proposed module layout (these paths are planned, not implemented):

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
- `packages/adapters`: persistence, model/embedding access and host capabilities.
- `packages/pi`: the native conversation/activity harness.
- `packages/mcp`: governed domain tool transport.
- `integrations/hermes`: native Python plugin and lifecycle bridge to the core.
- `apps/standalone`: thin composition for the Pi edition and local core service.

These are module seams, not a requirement for separate processes or a package
per noun. Keep internal modules private behind deliberately small interfaces.
Core-owned interfaces prevent adapter imports from flowing inward. Cross-domain
coordination belongs to explicit application use cases, not a universal object.

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
