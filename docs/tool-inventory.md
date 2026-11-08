# Companion tool inventory

The model-facing tool surface is runtime data: `TOOL_INVENTORY` in
`packages/core/src/application/tool-inventory.ts`, assembled from the tool
descriptor each domain owns (`packages/core/src/<domain>/tool.ts`) and exported
from `packages/core/src/index.ts`. Native harnesses and tool transports expose
this one list through the same dispatcher; neither defines tools of its own.
The tables below are rendered from the registry, and
`tests/core/tool-inventory.test.ts` fails if they drift.

Donor paths refer to PSFN Framework at the `DONOR_REVISION` recorded in the
registry (see [provenance](provenance.md)). `new` rows are Lite additions that
close a donor gap; they name the related donor code instead.

## Columns

- **Privacy**: `identity_by_design` (the companion's published identity, shown to
  any admitted caller), `audience_scoped` (each item filtered by the caller's
  trust and room ceiling), `conversation_scoped` (bound to the conversation that
  created it), `companion_private` (self turns or a confidential admission only),
  `automata_private` (worker-run learned state, never companion memory).
- **Admission**: the sensitivity the turn scope must admit before the action runs at all.
- **Restrictions**: the dispatcher enforces `foreground_only`, `self_audience_only`,
  admission and worker access before any handler runs. The owning domain handler
  enforces the rest: `companion_authored` (stored with companion authorship),
  `append_only` (history kept, corrections supersede), `current_scope_only`,
  `visibility_gated` (targets the audience cannot read are treated as missing),
  `approval_for_protected` (protected targets become an approval proposal),
  `proposal_only` (never applied directly), `idempotent` (retries do not
  duplicate), `grant_narrowing` (a worker gets at most its parent's authority).
- **Workers**: whether a bounded worker may call the action (`review_staged`
  means restricted writes are staged for review instead of applied).
- **Inference**: actions that may make a model call are marked; none is claimed zero-cost.

## Deliberately excluded donor surfaces

`wiki`, `notify`, `system`, `self_status`, `analysis_workbench`, `skill`,
`publication`, `automata_bus`, external channel MCP and the host practical tools
(filesystem, shell, web, repo) are host-owned or out of Lite scope. Identity
`commit_stage`/`cancel_stage` were unreachable in the donor and are dropped.
Introspection consent actions stay out until introspection is deliberately
introduced (charter). Memory `redact` was retired in the donor; letter
`disposition_*` depended on the excluded wiki and shards.

## Tools

<!-- inventory:start -->
### `orient` (domain: identity)

Orientation blocks for this conversation, prompt layers and persona.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `view` | read | conversation_scoped | public | current_scope_only | allowed | - | new: Donor only rendered blocks into the prompt; charter 11 requires a governed reader. Related: `src/faculties/core-memory/store.ts` |
| `append` | write | conversation_scoped | public | companion_authored, current_scope_only, foreground_only | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/faculties/core-memory/store.ts` |
| `replace` | write | conversation_scoped | public | companion_authored, current_scope_only, foreground_only | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/faculties/core-memory/store.ts` |
| `reorient` | write | conversation_scoped | public | companion_authored, current_scope_only, foreground_only | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/faculties/core-memory/store.ts` |
| `list_layers` | read | identity_by_design | public | - | allowed | - | `src/core/identity/prompt-tools.ts` |
| `get_layer` | read | identity_by_design | public | - | allowed | - | `src/core/identity/prompt-tools.ts` |
| `diff_layer` | read | identity_by_design | public | - | allowed | - | `src/core/identity/prompt-tools.ts` |
| `layer_history` | read | identity_by_design | public | - | allowed | - | `src/core/identity/prompt-tools.ts` |
| `update_layer` | write | identity_by_design | public | companion_authored, append_only, approval_for_protected | denied | - | `src/core/identity/prompt-tools.ts` |
| `rollback_layer` | write | identity_by_design | public | companion_authored, append_only, approval_for_protected | denied | - | `src/core/identity/prompt-tools.ts` |
| `toggle_layer` | write | identity_by_design | public | companion_authored, append_only, approval_for_protected | denied | - | `src/core/identity/prompt-tools.ts` |
| `update_persona` | write | identity_by_design | public | companion_authored, append_only, approval_for_protected | denied | - | `src/core/identity/prompt-tools.ts`<br>`src/core/identity/card-versioning.ts` |

### `values` (domain: identity)

Companion-authored values journal and the North Star, distinct from the constitution.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list_values` | read | audience_scoped | personal | - | allowed | - | `src/faculties/values/tools.ts`<br>`src/faculties/core-memory/tools.ts` |
| `add_value` | write | audience_scoped | personal | companion_authored, append_only | denied | - | `src/faculties/values/tools.ts`<br>`src/faculties/values/store.ts` |
| `revise_value` | write | audience_scoped | personal | companion_authored, append_only | denied | - | `src/faculties/values/tools.ts` |
| `north_star_list` | read | identity_by_design | public | - | allowed | - | `src/faculties/north-star/tools.ts` |
| `north_star_create` | write | identity_by_design | public | companion_authored, append_only, foreground_only | denied | - | `src/faculties/north-star/tools.ts`<br>`src/faculties/north-star/store.ts` |
| `north_star_update` | write | identity_by_design | public | companion_authored, append_only, foreground_only | denied | - | `src/faculties/north-star/tools.ts`<br>`src/faculties/north-star/store.ts` |
| `north_star_reorder` | write | identity_by_design | public | companion_authored, append_only, foreground_only | denied | - | `src/faculties/north-star/tools.ts`<br>`src/faculties/north-star/store.ts` |
| `north_star_retire` | write | identity_by_design | public | companion_authored, append_only, foreground_only | denied | - | `src/faculties/north-star/tools.ts`<br>`src/faculties/north-star/store.ts` |

### `memory` (domain: memory)

Durable typed memory and same-day scratchpad notes, filtered by audience.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `search` | read | audience_scoped | public | visibility_gated | allowed | may call model | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/tools/visibility.ts` |
| `get` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/tools/visibility.ts` |
| `shared_background` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/tools/visibility.ts` |
| `census` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/tools/visibility.ts` |
| `write` | write | audience_scoped | public | companion_authored, idempotent | review_staged | may call model | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/writer.ts`<br>`src/faculties/subagents/memory-governance.ts` |
| `import` | write | audience_scoped | public | companion_authored, idempotent | review_staged | may call model | `src/faculties/memory/tools.ts`<br>`src/faculties/subagents/memory-governance.ts` |
| `patch` | write | audience_scoped | public | companion_authored, visibility_gated, append_only | denied | - | `src/faculties/memory/tools.ts` |
| `propose_delete` | write | audience_scoped | public | visibility_gated, proposal_only | denied | - | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/deletion-proposals.ts` |
| `restore` | write | audience_scoped | public | companion_authored, visibility_gated, append_only | denied | - | `src/faculties/memory/tools.ts` |
| `scratchpad_list` | read | conversation_scoped | public | current_scope_only | allowed | - | `src/faculties/memory/tools/scratchpad.ts`<br>`src/faculties/memory/scratchpad-visibility.ts` |
| `scratchpad_add` | write | conversation_scoped | public | companion_authored, current_scope_only | allowed | - | `src/faculties/memory/tools/scratchpad.ts`<br>`src/faculties/memory/scratchpad-visibility.ts` |
| `scratchpad_replace` | write | conversation_scoped | public | companion_authored, current_scope_only | allowed | - | `src/faculties/memory/tools/scratchpad.ts`<br>`src/faculties/memory/scratchpad-visibility.ts` |
| `scratchpad_append` | write | conversation_scoped | public | companion_authored, current_scope_only | allowed | - | `src/faculties/memory/tools/scratchpad.ts`<br>`src/faculties/memory/scratchpad-visibility.ts` |
| `scratchpad_remove` | write | conversation_scoped | public | companion_authored, current_scope_only | allowed | - | `src/faculties/memory/tools/scratchpad.ts`<br>`src/faculties/memory/scratchpad-visibility.ts` |

### `session` (domain: sessions)

Navigate and search lived conversation history the current audience may read.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list` | read | audience_scoped | public | visibility_gated | allowed | - | `src/core/tools/session.ts`<br>`src/core/session/session-viewer-access.ts` |
| `search` | read | audience_scoped | public | visibility_gated | allowed | may call model | `src/core/tools/session-search.ts`<br>`src/core/session/search-runtime.ts` |
| `grep` | read | audience_scoped | public | visibility_gated | allowed | - | `src/core/tools/session-search.ts` |
| `messages` | read | audience_scoped | public | visibility_gated | allowed | - | `src/boundary/sandbox/capabilities/memory.ts` |
| `continuity_list` | read | audience_scoped | public | visibility_gated | allowed | - | new: Donor registered a continuity_list alias with no implementation; Lite adds the governed reader. Related: `src/core/session/continuity-artifacts.ts` |
| `new` | write | conversation_scoped | public | foreground_only, current_scope_only | denied | - | `src/core/tools/session.ts` |
| `resume` | write | audience_scoped | public | foreground_only, visibility_gated | denied | - | `src/core/tools/session.ts` |
| `wake_return` | write | conversation_scoped | public | companion_authored, visibility_gated, append_only | denied | - | `src/core/tools/session.ts`<br>`src/core/session/continuity-artifacts.ts` |
| `start_focus` | write | conversation_scoped | public | foreground_only, visibility_gated | denied | - | `src/core/tools/focus.ts` |
| `complete_focus` | write | conversation_scoped | public | visibility_gated, append_only | denied | may call model | `src/core/tools/focus.ts`<br>`src/core/session/manager/focus-session-runtime.ts` |

### `episode` (domain: episodes)

Lived episodes and arcs; machine drafts stay distinct from companion-authored meaning.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `search` | read | audience_scoped | public | visibility_gated | allowed | may call model | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/retrieval/episode-search.ts`<br>`src/faculties/memory/retrieval/episodic.ts` |
| `get` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/memory/retrieval/episode-drilldown.ts`<br>`src/faculties/memory/retrieval/episodic.ts` |
| `timeline` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/memory/tools.ts`<br>`src/faculties/memory/retrieval/episodic.ts` |
| `author_meaning` | write | companion_private | confidential | companion_authored, self_audience_only, append_only | denied | - | new: Donor had no model-facing meaning writer; meaning was authored only inside the dream pass. Related: `src/faculties/memory/episodic/dream-meaning-pass.ts`, `src/faculties/memory/episodic/store-port.ts` |

### `journal` (domain: journals)

Companion-authored workspace journal, reflection records and private letters.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list` | read | conversation_scoped | public | visibility_gated | allowed | - | `src/boundary/integrations/journal/tools.ts`<br>`src/boundary/integrations/journal/provenance.ts` |
| `read` | read | conversation_scoped | public | visibility_gated | allowed | - | `src/boundary/integrations/journal/tools.ts`<br>`src/boundary/integrations/journal/provenance.ts` |
| `search` | read | conversation_scoped | public | visibility_gated | allowed | - | `src/boundary/integrations/journal/tools.ts`<br>`src/boundary/integrations/journal/provenance.ts` |
| `write` | write | conversation_scoped | public | companion_authored, visibility_gated | denied | - | `src/boundary/integrations/journal/tools.ts`<br>`src/boundary/integrations/journal/provenance.ts` |
| `append` | write | conversation_scoped | public | companion_authored, visibility_gated | denied | - | `src/boundary/integrations/journal/tools.ts`<br>`src/boundary/integrations/journal/provenance.ts` |
| `reflections_list` | read | companion_private | confidential | - | denied | - | new: Donor reflection JSONL journals had no model-facing reader; Lite needs complete journal access. Related: `src/persistence/journals/reflection-journal.ts`, `src/persistence/journals/reflection-substrate.ts` |
| `reflections_read` | read | companion_private | confidential | - | denied | - | new: Donor reflection JSONL journals had no model-facing reader; Lite needs complete journal access. Related: `src/persistence/journals/reflection-journal.ts`, `src/persistence/journals/reflection-substrate.ts` |
| `letter_compose` | write | companion_private | confidential | companion_authored, idempotent, append_only | denied | - | `src/core/tools/letter.ts`<br>`src/core/letters/service.ts` |
| `letter_list` | read | companion_private | confidential | - | denied | - | `src/core/tools/letter.ts`<br>`src/core/letters/service.ts` |
| `letter_read` | read | companion_private | confidential | - | denied | - | `src/core/tools/letter.ts`<br>`src/core/letters/service.ts` |
| `letter_place` | write | companion_private | confidential | companion_authored, append_only | denied | - | `src/core/tools/letter.ts`<br>`src/core/letters/service.ts` |
| `letter_archive` | write | companion_private | confidential | companion_authored, append_only | denied | - | `src/core/tools/letter.ts`<br>`src/core/letters/service.ts` |

### `contact` (domain: contacts)

Contacts, trust, relationships and tracking consent, filtered by audience.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list` | read | audience_scoped | public | visibility_gated | denied | - | `src/core/contacts/tools.ts`<br>`src/core/contacts/contact-viewer-access.ts` |
| `search` | read | audience_scoped | public | visibility_gated | denied | - | `src/core/contacts/tools.ts`<br>`src/core/contacts/contact-viewer-access.ts` |
| `lookup` | read | audience_scoped | public | visibility_gated | denied | - | `src/core/contacts/tools.ts`<br>`src/core/contacts/contact-viewer-access.ts` |
| `note` | write | audience_scoped | public | visibility_gated, companion_authored, append_only | denied | - | `src/core/contacts/tools.ts` |
| `set_trust` | write | audience_scoped | public | visibility_gated, companion_authored, foreground_only | denied | - | `src/core/contacts/tools.ts` |
| `propose_trust` | write | audience_scoped | public | visibility_gated, proposal_only | denied | - | `src/core/contacts/tools.ts` |
| `set_relationship` | write | audience_scoped | public | visibility_gated, companion_authored, approval_for_protected | denied | - | `src/core/contacts/relationship-tools.ts` |
| `propose_relationship` | write | audience_scoped | public | visibility_gated, proposal_only | denied | - | `src/core/contacts/relationship-tools.ts` |
| `link_identity` | write | audience_scoped | public | visibility_gated, companion_authored, approval_for_protected | denied | - | `src/core/contacts/tools.ts` |
| `set_channel_privacy` | write | audience_scoped | public | visibility_gated, companion_authored | denied | - | `src/core/contacts/tools.ts` |
| `set_machine_intelligence` | write | audience_scoped | public | visibility_gated, companion_authored | denied | - | `src/core/contacts/tools.ts` |
| `block` | write | audience_scoped | public | visibility_gated, companion_authored, foreground_only | denied | - | `src/core/contacts/tools.ts` |
| `unblock` | write | audience_scoped | public | visibility_gated, companion_authored, foreground_only | denied | - | `src/core/contacts/tools.ts` |

### `emotion` (domain: emotion)

Inspect scoped affect estimates and record companion-authored self-reports.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read` | read | audience_scoped | public | current_scope_only | denied | - | new: Donor exposed emotion only through prompt variables; Lite adds a governed scoped reader. Related: `src/core/emotion/state.ts`, `src/core/emotion/scoped-emotion.ts`, `src/core/emotion/persona-adaptation.ts` |
| `appraisals` | read | companion_private | confidential | - | denied | - | new: Donor kept the appraisal chain internal; charter 11 requires inspection. Related: `src/core/emotion/appraisal.ts`, `src/core/emotion/appraisal-state.ts` |
| `self_report` | write | audience_scoped | public | companion_authored, current_scope_only, append_only | denied | - | new: Donor had no companion-authored affect record; estimates must not stand in for one. Related: `src/core/emotion/state.ts` |

### `concern` (domain: intention)

Open concerns, follow-ups and care reminders the companion holds.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list` | read | audience_scoped | public | visibility_gated | allowed | - | `src/faculties/core-memory/tools.ts`<br>`src/core/intention/concern-visibility.ts` |
| `create` | write | audience_scoped | public | companion_authored, visibility_gated | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/core/intention/tools.ts` |
| `resolve` | write | audience_scoped | public | companion_authored, visibility_gated | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/core/intention/tools.ts` |
| `transition` | write | audience_scoped | public | companion_authored, visibility_gated | denied | - | `src/faculties/core-memory/tools.ts`<br>`src/core/intention/tools.ts` |
| `follow_up_list` | read | conversation_scoped | public | visibility_gated | allowed | - | `src/core/scheduler/schedule-tool.ts`<br>`src/core/scheduler/schedule-visibility.ts` |
| `follow_up_create` | write | conversation_scoped | public | visibility_gated, companion_authored, idempotent | denied | - | `src/core/scheduler/schedule-tool.ts`<br>`src/core/intention/pending-follow-ups.ts` |
| `follow_up_activate` | write | conversation_scoped | public | visibility_gated, foreground_only | denied | - | `src/core/scheduler/schedule-tool.ts`<br>`src/core/intention/pending-follow-ups.ts` |
| `reminder_create` | write | conversation_scoped | public | companion_authored, visibility_gated, idempotent | denied | - | `src/core/scheduler/schedule-tool.ts`<br>`src/core/intention/care-reminders.ts` |

### `activity` (domain: activity)

What the companion has been doing: purpose, status, outcome, artifacts and reflection.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `recent` | read | audience_scoped | public | visibility_gated | allowed | - | new: Donor had no unified activity record; recent work was scattered across worker status, sessions and free time. Related: `src/faculties/subagents/tools.ts`, `src/core/session/continuity-artifacts.ts`, `src/core/scheduler/free-time-activity.ts` |
| `get` | read | audience_scoped | public | visibility_gated | allowed | - | new: Donor had no unified activity record; recent work was scattered across worker status, sessions and free time. Related: `src/faculties/subagents/tools.ts`, `src/core/session/continuity-artifacts.ts`, `src/core/scheduler/free-time-activity.ts` |
| `start` | write | audience_scoped | public | companion_authored, current_scope_only | allowed | - | new: Donor had no unified activity record; recent work was scattered across worker status, sessions and free time. Related: `src/faculties/subagents/tools.ts`, `src/core/session/continuity-artifacts.ts`, `src/core/scheduler/free-time-activity.ts` |
| `update` | write | audience_scoped | public | companion_authored, visibility_gated, append_only | allowed | - | new: Donor had no unified activity record; recent work was scattered across worker status, sessions and free time. Related: `src/faculties/subagents/tools.ts`, `src/core/session/continuity-artifacts.ts`, `src/core/scheduler/free-time-activity.ts` |

### `automata` (domain: automata)

Bounded task workers: spawn, steer, wait on, cancel and inspect.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `spawn` | write | conversation_scoped | public | grant_narrowing, idempotent | denied | may call model | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/capability-access.ts` |
| `message` | write | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |
| `wait` | read | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |
| `cancel` | write | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |
| `status` | read | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |
| `discover` | read | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |
| `inspect` | read | conversation_scoped | public | visibility_gated | denied | - | `src/faculties/subagents/tools.ts`<br>`src/faculties/subagents/task-visibility.ts` |

### `free_time` (domain: scheduler)

Free time, rest and self-directed scheduled time.

| Action | Access | Privacy | Admission | Restrictions | Workers | Inference | Donor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `status` | read | companion_private | confidential | - | allowed | - | new: Donor free-time choice was a tool-less JSON model call; Lite makes inspection and choice governed actions. Related: `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window-policy.ts` |
| `choose` | write | companion_private | confidential | companion_authored, self_audience_only, idempotent | denied | - | new: Donor free-time choice was a tool-less JSON model call; Lite makes inspection and choice governed actions. Related: `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window-policy.ts`, `src/core/scheduler/free-time.ts` |
| `rest` | write | companion_private | confidential | companion_authored, self_audience_only, idempotent | denied | - | new: Donor free-time choice was a tool-less JSON model call; Lite makes inspection and choice governed actions. Related: `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window-policy.ts`, `src/core/scheduler/free-time.ts` |
| `defer` | write | companion_private | confidential | companion_authored, self_audience_only, idempotent | denied | - | new: Donor free-time choice was a tool-less JSON model call; Lite makes inspection and choice governed actions. Related: `src/core/scheduler/free-time-chooser.ts`, `src/core/scheduler/rest-window-policy.ts`, `src/core/scheduler/free-time.ts` |
| `scheduled_list` | read | companion_private | confidential | - | allowed | - | `src/core/scheduler/schedule-tool.ts` |
| `schedule_prompt` | write | companion_private | confidential | companion_authored, idempotent | denied | - | `src/core/scheduler/schedule-tool.ts` |
| `update_template` | write | companion_private | confidential | companion_authored, idempotent | denied | - | `src/core/scheduler/schedule-tool.ts` |
| `run_template` | write | companion_private | confidential | companion_authored, idempotent | denied | may call model | `src/core/scheduler/schedule-tool.ts`<br>`src/core/scheduler/reflection-policy.ts` |
<!-- inventory:end -->
