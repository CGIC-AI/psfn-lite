# Companion tool inventory

The companion's tools are the donor's. Lite defines no tool of its own and
keeps no copy of the catalog. The tools are whatever the extracted
`SubstrateAgent` registers at run time, core and extended
(`packages/lifecycle/src/tools.ts` reads them through the donor's tool
catalog). Every surface gets that same list:

- **Pi turns** (standalone `once`, `chat` and the scheduler): the donor
  agent offers the tools to the model itself.
- **MCP**: one MCP tool per donor tool, with the donor's name, description
  and TypeBox parameter schema. A call runs as a model tool call of the
  caller's open host-driven turn, so the donor's gates, argument checks and
  privacy rules apply as in any donor turn.
- **Hermes**: Hermes's MCP client registers the MCP tools, and the plugin's
  `pre_tool_call` gate lets them run only inside a Lite turn. `prepare` also
  returns the names the donor offered for the turn.

The conformance inventory test (`tests/conformance/conformance.integration.test.ts`)
checks that the MCP list equals the live donor catalog, that a Hermes turn
is offered the same tools as a Pi turn, and that no served tool or action
names an excluded subsystem. The Hermes runner (`test_conformance.py`)
checks that Hermes registers exactly that catalog.

## Tools served (standalone defaults)

Measured on the standalone runtime with its default owner files (the Hermes
e2e host, 2026-11-08). All 14 were offered in a plain turn. Descriptions are
the first sentence of the donor's own. Donor paths are under the donor's
`src/`, at the same path in `packages/companion/src/`.

| Tool | What it does (donor description) | Actions | Donor factory |
|---|---|---|---|
| `response_control` | Record an intentional decision to send no outward response for the current turn. | `no_reply` | `src/core/agent/no-reply-tool.ts` |
| `tool_search` | Look up long-form documentation for a canonical tool by name, purpose, action, or parameter. | (no action field) | `src/core/agent/substrate-agent/adaptive-tools-runtime.ts` |
| `toolset` | Inspect the always-callable catalog, request advisory ranking, or manage presentation-order pins. | `list`, `suggest`, `describe`, `pin`, `unpin` | `src/core/agent/substrate-agent/adaptive-tools-runtime.ts` |
| `identity` | Inspect and deliberately revise prompt layers or character-card persona fields through the audited identity boundary. | `list_layers`, `get_layer`, `diff_layer`, `history`, `update_layer`, `rollback_layer`, `toggle_layer`, `update_persona`, `commit_stage`, `cancel_stage` | `src/core/identity/prompt-tools.ts` |
| `session` | Navigate conversation continuity, transcript evidence, wake summaries, and bounded focus work. | `list`, `new`, `resume`, `search`, `grep`, `wake_return`, `start_focus`, `complete_focus` | `src/core/tools/session.ts` |
| `letter` | Write and receive unhurried private correspondence through the shared Letters bin. | `compose`, `list`, `read`, `place`, `archive`, `disposition_list`, `disposition_read` | `src/core/tools/letter.ts` |
| `contact` | Read and deliberately maintain canonical people, relationship state, identities, privacy, blocks, and known-peer availability. | `list`, `search`, `lookup`, `note`, `set_trust`, `propose_trust`, `set_relationship`, `propose_relationship`, `link_identity`, `set_channel_privacy`, `set_machine_intelligence`, `block`, `unblock` | `src/core/contacts/tools.ts` |
| `orient` | Maintain scoped continuity blocks, values, open threads, and explicit introspection consent choices. | `append`, `replace`, `reorient`, `values_list`, `values_add`, `values_update`, `create_concern`, `list_concerns`, `resolve_concern`, `transition_concern`, `introspection_consent_get`, `introspection_consent_set`, `introspection_turn_sensitivity_set` | `src/faculties/core-memory/tools.ts` |
| `subagent` | Direct bounded, short-horizon automata that take on focused work in parallel or in isolation and return with what they found. | `spawn`, `message`, `wait`, `cancel`, `status`, `discover`, `inspect` | `src/faculties/subagents/tools.ts` |
| `memory` | Store and retrieve durable typed memories that should survive beyond the current session. | `write`, `search`, `episode_search`, `get`, `shared_background`, `census`, `exists`, `timeline`, `import`, `patch`, `redact`, `delete`, `restore` | `src/faculties/memory/tools.ts` |
| `scratchpad` | Keep temporary working notes and excerpts that may expire after the current day. | `list`, `add`, `replace`, `append`, `remove` | `src/faculties/memory/tools/scratchpad.ts` |
| `journal` | Read and write durable companion-authored markdown notes, reflections, and topic journals. | `list`, `read`, `write`, `append`, `search` | `src/boundary/integrations/journal/tools.ts` |
| `schedule` | Manage durable follow-ups, reminders, heartbeat templates, and one-shot scheduled prompts. | `list`, `create_follow_up`, `activate_follow_up`, `create_reminder`, `trigger_reminder`, `list_templates`, `update_template`, `run_template`, `schedule_prompt` | `src/core/scheduler/schedule-tool.ts` |
| `north_star` | Maintain a small ordered set of long-horizon guiding intentions. | `list`, `create`, `update`, `delete`, `reorder` | `src/faculties/north-star/tools.ts` |

Each action's required and optional arguments, rules and examples are in
the tool's own description and schema, as the donor wrote them
(`src/core/agent/tool-surface/descriptions/`). The donor's tool documentation
is in `packages/companion/README.md` ("Self-Direction Tool Surfaces"). The
catalog is built from the runtime's configuration at start, and the donor
decides per turn which tools to offer. So the list above is a measurement,
not a contract.

## Donor surfaces Lite does not serve

The donor registry (`src/core/agent/tool-surface/registry.ts`) still
describes 17 surfaces whose factories were scaffolding. They were deleted in
extraction Step B7, so no factory builds them and they are never in the
catalog: `fs`, `repo`, `shell`, `web`, `mcp`, `world`,
`analysis_workbench`, `self_status`, `system`, `skill`, `wiki`, `beads`,
`notify`, `generate_image`, `selfie_create`, `publication` and `vault`
(`SCAFFOLDING_HOSTED_TOOL_SURFACES` in
`canonical-tool-catalog.test-support.ts`). Host practical tools
(filesystem, shell, web, repositories) belong to the host. The
`automata_bus` tool is built for bounded workers inside their own runs, not
for the companion's turns.
