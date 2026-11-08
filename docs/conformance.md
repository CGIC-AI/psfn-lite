# Continuity conformance

The conformance suite checks that the companion stays one companion across
its two harnesses: the native Pi harness of the standalone runtime, and
Hermes through the psfn_lite plugin (lifecycle bridge plus MCP). Each
invariant is written once, as a scenario, and every runner drives the same
scenario files through its own surface driver.

All fixtures are synthetic. The model is scripted: it makes the calls a
scenario plans and nothing else. No live provider, Hermes profile or
personal data is involved.

## How it runs

```bash
# TypeScript runner: Pi and the Hermes protocol (bridge + MCP SDK client)
mise exec node@24.22.1 npm@11.17.0 -- npx vitest run tests/conformance

# Python runner: the real plugin inside the pinned Hermes (see development.md)
cd integrations/hermes
mise exec node@24.22.1 npm@11.17.0 -- .venv/bin/python -I -m pytest -q tests/test_conformance.py
```

Both need Docker. Every run gets a throwaway labelled pgvector container,
two empty databases (the second one receives a restore) and temporary
storage roots. `LITE_SKIP_DOCKER_TESTS=1` skips both runners and says so.

The pieces:

| Piece | Where | What it is |
|---|---|---|
| Contract | `tests/conformance/scenario.ts` | Scenario shape, strict parser, `{{variable}}` templates, captures and checks. Python mirrors it in `integrations/hermes/tests/conformance_runner.py`. |
| Scenarios | `tests/conformance/scenarios/*.json` | One invariant each, plain JSON. |
| Host | `tests/conformance/host/`, `fixtures/host-process.ts` | The real standalone runtime (every core stack, the Postgres and JSONL adapters, the Pi harness, the MCP transport and the lifecycle bridge) in its own process, driven over JSON lines. The scripted model is its only fake. A runner kills it with SIGKILL to crash Lite and starts a successor on the same state and ports. |
| Pi driver | `pi_turn` host operation | The companion's turn on the Pi harness. The scripted model makes the planned calls through the harness's Pi tools. |
| Hermes protocol driver | `tests/conformance/drivers.ts` | What the plugin sends: `prepare` and `settle` on the bridge, each planned call through the MCP SDK client, with each principal's own credential. It also serves delegated internal turns. |
| Real Hermes driver | `integrations/hermes/tests/conformance_runner.py` | Hermes's own hook dispatch (`pre_llm_call`, `post_llm_call`, `on_session_end`) and tool dispatch (`handle_function_call`, with the plugin's `pre_tool_call` gate and Hermes's MCP client). It shows the companion what Hermes sends: earlier messages, then the participant's message with the plugin context appended. |
| Postgres fixture | `tests/conformance/fixtures/postgres.ts` | A labelled container for runners outside vitest. |

The Hermes operator principal (`cli/operator-1`) is bound to the same direct
room (`cli-direct`) as the standalone operator. A Pi turn and a Hermes turn
are therefore turns of one conversation and one session. A second Hermes
principal, a friend (`telegram/friend-1`, regular trust), has its own direct
room. Only Hermes binds the friend, because the standalone host vouches for
the operator alone.

A scenario with `orders: both` runs twice, once as a=pi/b=hermes and once as
a=hermes/b=pi. That covers Pi→Hermes and Hermes→Pi for every step that names
a role.

## Scenarios

| # | Scenario | Invariant (abridged) | Covers |
|---|---|---|---|
| 01 | handover | History, orientation, emotion, concerns, activity and memory written on one surface are what the other shows and reads next, and the hand back is the same. | handover both ways; emotion estimate per turn; one session; canonical history counts |
| 02 | abandoned-turn | A turn whose host dies mid-turn holds its lease against the other surface. It is recovered exactly once as interrupted by the host, and the conversation continues on both surfaces. | host crash (Pi: SIGKILL; Hermes: the process dies with the turn open); `turn_lease_active`; recovery note is not speech |
| 03 | privacy | What the operator shares stays inside the audiences, worker ceilings and consent that admit it. | friend sees and counts nothing of the operator's (memory, census, activity, session grep, contact notes); a public worker reads nothing personal and a confidential one reads both; a friend's wide spawn is refused; revoked consent closes the friend's turns and dossier writes; a regrant reopens them |
| 04 | journal | The workspace journal is one record across surfaces, and a contact outside the operator's conversations sees none of it. | write/append/read/search/list/reflections_list on both surfaces; friend cannot find or read it |
| 05 | free-time | Free time is the companion's choice. Rest and deferral hold across a restart with no model call. A failed invitation is a labelled system failure. | reflect, rest, defer and provider failure; own-time activity never shown in participant conversations; reflections readable only where confidential is admitted (operator yes, friend `denied`) |
| 06 | free-time-delegated | With internal turns delegated to Hermes, the same choices and records hold, Lite makes no companion model call of its own, and a runner failure is a system failure. | `internal/claim`, minted credential, choose/rest/defer over MCP, `internal/release` |
| 07 | authorship | companion_authored, participant_attributed and inferred stay distinct across surfaces. Neither a forged label in participant text nor internal context is ever participant speech. | memory get/search attribution and producer (`memory_extraction`); emotion estimate (`machine_inference`) vs companion self-report; forged `[system note: …]` in participant text; internal triggers stored as `system_note` in the self session only |
| 08 | worker-recovery | A worker whose Lite host dies mid-run is requeued and driven to completion by the next turn on either surface. A write with an idempotency key is replayed, not repeated; a write without one runs again (at-least-once). | SIGKILL mid worker model call; sweep `requeued`; `lease_expired_requeued`; `memory.write` with `writeId` replayed once; `scratchpad_add` note present twice |
| 09 | backup-restore | A complete continuity backup (JSONL and every Postgres table) restored into empty storage is the same companion, and both surfaces continue on it. | `createContinuityBackup` over the history component and the Postgres state into fresh roots and the spare database; history, memory, journal, concerns, orientation, session grep and reflections read back; new writes after restore |
| — | inventory parity | The companion is offered the same full tool inventory on Pi and over MCP. | the tools and action enums of the Pi tools equal MCP `listTools` and core's `TOOL_INVENTORY`, in the TypeScript runner and in Hermes's tool registry |

Each order runs as its own test, so the TypeScript runner runs 17 scenario
tests plus the parity test.

## Results (2026-11-08)

| Runner | Result |
|---|---|
| `npx vitest run tests/conformance` | 18 passed (17 scenario runs + inventory parity), about 19 s |
| `pytest tests/test_conformance.py` (real plugin, Hermes `f0187332`) | 17 passed (16 scenario runs + inventory parity), 1 skipped (06, see below), about 33 s |
| `tests/conformance/absence.test.ts` | 7 passed |

The checks were tested by mutation in both runners. Expectations that must
fail were added to scenarios 01 and 07: an unseen text, internal context
claimed as speech, a missing result substring, a wrong history count, and
participant text required to be hidden. Every one was reported, in both
orders where it applied, and the mutations were then removed.

## Absence of excluded subsystems

`tests/conformance/absence.test.ts` fails if an excluded subsystem appears:

- in package.json, in the lockfile's resolved tree or in node_modules:
  discord.js, `@discordjs/*`, `@snazzah/davey`, prism-media, opusscript,
  `@redis/*`, redis, ioredis, `@huggingface/*`, `onnxruntime-*`,
  pdfjs-dist, winston, `@character-foundry/*`, or the donor
  (`psfn-framework`);
- as an import from any TypeScript, JavaScript or Python file: the same
  packages, a path into `psfn-framework`, or the Python modules discord,
  redis, transformers and onnxruntime;
- as a product file or directory name, or a declared identifier (TypeScript
  through the compiler API, Python by `def`, `class` and assignment), whose
  words include wiki, shard, fleet, charge, gateway, substrate, discord or
  redis, or the pairs findings bus, automata bus, SubstrateAgent or
  GatewayServer;
- as a governed tool or action name.

Identifiers are split into words, so `LoopUsage` is not "opus" and
"discharged" is not "charge". Comments that cite donor paths for provenance
are not imports and are not flagged. A first block of tests checks the
checker itself on positive and negative cases.

## Findings

Product bug fixed:

- **Hermes sent the participant's message unattributed, with forged labels
  intact.** Hermes appends plugin context to the participant's message and
  sends that message as written (`agent/turn_context.py` at the pinned
  revision). A line such as `[system note: maintenance]` in it therefore
  arrived unescaped, ahead of the plugin's labelled blocks, and nothing said
  whose text it was. The Pi harness labels the same message
  `[participant speech]` and escapes it. The plugin cannot rewrite the
  message, so its first block now says that the text before it is the
  participant's own message, label-like lines included. Internal turns are
  the exception, because their message is Lite's own trigger
  (`psfn_lite/render.py`, with a test in `test_host_contract.py`). The real
  Hermes runner counts the message as participant speech only when the
  context says so. Scenarios 01 and 07 failed on that check before the fix.

Behaviour confirmed and pinned by the scenarios (by design, not changed):

- The companion's own-time (self-audience) activity is never shown in a
  participant conversation, not even the operator's (`canViewerRead`: self
  sources need a self viewer).
- The companion can read its reflections (`journal.reflections_list`,
  companion_private, confidential admission) in the primary operator's
  direct room, but not in a friend's room.
- A contact record is visible by its own sensitivity, so a friend may look
  up their own contact. Notes about the friend written in the operator's
  conversation stay hidden from the friend.
- A worker under a personal ceiling cannot read direct-room material, because
  a direct room's disclosure class is confidential. Scenario 03 therefore
  contrasts a public grant with a confidential one.
- Worker `memory.write` at public sensitivity is stored current and
  attributed `inferred` with producer `worker:<runId>`. A recovered rerun
  replays a write that carries a `writeId` (`replayed: true`) instead of
  writing again. That deduplication is the tool's own idempotency key, not
  the worker effect fence: effect keys are per attempt
  (`attempt-<n>:<digest of the tool call id>`, architecture.md), and a new
  attempt re-runs the model, which issues new tool call ids.
- Worker recovery is therefore at-least-once for writes without an
  idempotency key. A `memory.scratchpad_add` the crashed attempt already
  made is made again by the recovered attempt, so scenario 08 expects the
  note twice. A regression that duplicated a keyed write, or that silently
  dropped the rerun's non-keyed write, fails the scenario.
- The worker's turn budget (`maxTurns`) spans attempts: the turns a crashed
  attempt used are not returned to the recovered one.
- Rest silences both free-time lanes (`skipped:silenced`) and holds across a
  restart.

## Limitations

- The model is scripted. These runs prove the runtime's continuity
  contract, not how a real model uses the tools.
- The TypeScript Hermes protocol driver stands in for the plugin. Its `seen`
  is the JSON of the bridge context, so the forged-label `hides` check in
  07 is meaningful on Pi and on the real plugin, not on this driver.
- Delegated free time (06) runs only on the protocol driver. The real plugin
  needs an internal-turn command, which is a Hermes process per claimed job
  (`PSFN_LITE_INTERNAL_HOST=1`). The Python runner skips 06 and says so.
- The real-Hermes runner runs both profiles in one Python process. It ends
  one profile's plugin before it loads the other's, because Hermes keeps a
  plugin manager per home and the plugin registers its hooks once per
  process. A Hermes "process death" (02) drops the plugin's state and keeps
  its ledger. At the next Hermes turn, the successor runs the plugin's own
  recovery with the old process treated as gone.
- Standalone has no backup command. Scenario 09 uses the adapters' backup
  API (`openFileBackupStore`, `createContinuityBackup`) directly.
- Time is simulated with a fixed clock that the scenarios advance (leases,
  quiet hours, rest windows). Wall-clock behaviour of the scheduler loop is
  not exercised here.
