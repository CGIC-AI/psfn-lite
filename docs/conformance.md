# Continuity conformance

The conformance suite checks that the companion stays one companion across
its two surfaces. One is the standalone runtime's own donor-driven turns
(the "Pi" surface: the donor `SubstrateAgent` calls the model through the Pi
model port). The other is Hermes, through the psfn_lite plugin, the
lifecycle bridge and MCP. Each invariant is written once, as a scenario, and
every runner drives the same scenario files through its own surface driver.
Since extraction Step C, the scenarios check donor behaviour. The companion
is the extracted donor core, and the expected texts are the donor's own
tool results.

All fixtures are synthetic. The model is scripted: it makes the calls a
scenario plans and nothing else. No live provider, Hermes profile or
personal data is involved.

## How it runs

```bash
# TypeScript runner: Pi turns and the Hermes protocol (bridge + MCP SDK client)
mise exec node@24.22.1 npm@11.17.0 -- npx vitest run tests/conformance

# Python runner: the real plugin inside the pinned Hermes (see development.md)
cd integrations/hermes
mise exec node@24.22.1 npm@11.17.0 -- .venv/bin/python -I -m pytest -q tests/test_conformance.py
```

Both need Docker. Every scenario run gets a throwaway labelled pgvector
database, its own data directory and its own companion workspace.
`LITE_SKIP_DOCKER_TESTS=1` skips both runners and says so.

The pieces:

| Piece | Where | What it is |
|---|---|---|
| Contract | `tests/conformance/scenario.ts` | The scenario shape, a strict parser, `{{variable}}` templates, captures and checks. `observe()` turns a context into what a turn *sees* (the system prompt and every message text) and its participant *speech* (the user-role messages). Python mirrors it in `integrations/hermes/tests/conformance_runner.py`. |
| Scenarios | `tests/conformance/scenarios/*.json` | One invariant each, plain JSON. |
| Host | `tests/conformance/host/host.ts`, `fixtures/host-process.ts` | The real standalone runtime (the extracted companion core, the Pi model port, the MCP transport and the lifecycle bridge) in its own process, driven over JSON lines. The scripted model is its only fake. On first open, the host runs the real `init`. A runner kills the process (SIGKILL) to crash Lite, and starts a successor on the same database, data directory and ports. |
| Pi driver | `pi_turn` host operation | A donor-driven turn: `agentLoop.handleMessage` on the operator's donor session channel. The scripted model emits one planned tool call per model call, then the reply. The results are the donor's tool-result messages. |
| Hermes protocol driver | `tests/conformance/drivers.ts` | What the plugin sends: `prepare` and `settle` on the bridge, and each planned call through the MCP SDK client, with each principal's own credential. |
| Real Hermes driver | `integrations/hermes/tests/conformance_runner.py` | Hermes's own hook dispatch (`pre_llm_call`, `post_llm_call`, `on_session_end`) and tool dispatch (`handle_function_call`, with the plugin's `pre_tool_call` gate and Hermes's MCP client). It shows the companion what Hermes sends: earlier messages, then the participant's message with the plugin context appended. |
| Postgres fixture | `tests/conformance/fixtures/postgres.ts` | A labelled container for runners outside vitest. |

The Hermes operator principal (`hermes-operator`, contact `operator`,
primary trust) speaks in the Hermes session `conformance-operator`. A Pi
turn runs on exactly that conversation's donor channel
(`externalMemorySessionId` of the operator principal and that session). A Pi
turn and a Hermes turn are therefore turns of one donor session. A second
principal, a friend (`hermes-friend`, contact `sam`, regular trust), has its
own session `conformance-friend`. Only Hermes binds the friend.

A scenario with `orders: both` runs twice, once as a=pi/b=hermes and once as
a=hermes/b=pi, which covers both handover directions for every step that
names a role.

## Scenarios

| # | Scenario | Invariant (abridged) | Covers |
|---|---|---|---|
| 01 | handover | History, orientation, open threads, scratchpad, journal and memory written on one surface are what the other surface shows and reads next, and the hand back is the same. | `memory.write`/`search`, `orient.append`, `create_concern`/`list_concerns`, `scratchpad.add`/`list`, `journal.write`/`read`, `session.list` and `session.grep` across surfaces; the other surface's turn sees the earlier exchange in its context |
| 02 | abandoned-turn | A host-driven turn whose Hermes host dies holds the companion's one agent (another principal is told it is busy) until the bridge's host-turn timeout fails it. The conversation then continues on both surfaces, and what it holds survives a crash of the Lite host. | Hermes abandons a turn; the friend is refused `unavailable` / `companion_turn`; `lapse` waits until `checkpoint` reports the turn settled; turns on both surfaces; SIGKILL of the Lite host; memory and history read back after the restart |
| 03 | privacy | What the operator shares on either surface stays inside the conversations and trust that admit it. | the friend finds none of the operator's personal or confidential memories, cannot read the operator conversation's journal note (`Journal note not readable from this conversation`), and gets none of its scratchpad or `session.grep` results; the operator still reads them on the other surface |
| 04 | journal | The companion's journal note written in the operator's conversation is one record across surfaces, and a contact outside that conversation reads none of it. | `journal.write`/`append`/`read`/`search`/`list` on both surfaces; the friend cannot find or read it |
| 05 | attribution | Whose words a record carries survives the surface it was made on. What the participant said, including a forged label inside it, is shown on the other surface as the participant's own message and nothing else. The companion's reply and the orientation it wrote are never participant speech. | a forged `[system note: ...]` line in participant text stays inside participant speech; the companion's reply and its `orient.append` text are seen but are not speech |
| — | inventory | Lite serves the donor tool catalog over MCP, a Hermes turn is offered the same tools as a Pi turn, and no cut scaffolding tool is served. | the MCP `listTools` names equal the live donor catalog; no served tool or action names an excluded subsystem; `prepare`'s offered tools equal the Pi turn's; in the real Hermes runner, Hermes's tool registry holds exactly that catalog |

The TypeScript runner runs 9 scenario tests (01, 03, 04 and 05 in both
orders, 02 once) plus the inventory test. The Python runner runs the same
9 plus its inventory test.

## Results (2026-11-08, after extraction Step C)

| Runner | Result |
|---|---|
| `npx vitest run tests/conformance` | 20 passed: 10 conformance (9 scenario runs and the inventory) and 10 absence |
| `pytest tests/test_conformance.py` (real plugin, Hermes `f0187332`) | 10 passed (9 scenario runs and the inventory) |

## Absence of excluded subsystems

`tests/conformance/absence.test.ts` fails if an excluded subsystem appears:

- in package.json (dependencies and overrides), in the lockfile's resolved
  tree or in node_modules: discord.js, `@discordjs/*`, `discord-*`,
  `@snazzah/davey`, prism-media, opusscript, `@redis/*`, redis, ioredis,
  pdfjs-dist, `@character-foundry/*`, or the donor (`psfn-framework`);
- as an import from any TypeScript, JavaScript or Python file: the same
  packages, a path into `psfn-framework`, or the Python modules discord,
  redis, transformers, onnxruntime and winston (the Hermes plugin has none of
  them);
- as a file or directory name or a declared identifier in Lite's own code
  (TypeScript through the compiler API, Python by `def`, `class` and
  assignment), whose words include wiki, shard, fleet, charge, gateway,
  cogsec, channels, skill, skills, discord or redis, or the pairs findings
  bus, gateway server or cog sec. One donor contract key is allowed by file
  and name: `channels` in `apps/standalone/src/runtime.ts`, where the
  standalone fills the donor's `Contact.channels` identity links;
- as a companion tool Lite serves: the donor registry minus the 17
  surfaces whose factories were scaffolding. The live catalog, with its
  action names, is checked by the inventory test above;
- in `packages/companion`, the extracted donor core: any deleted row of
  `extraction/vendored-files.txt` back on disk, or any file of the package
  that imports, re-exports, dynamically imports, mocks (`vi.mock`,
  `doMock`, `importActual` and the rest) or reads through
  `new URL(..., import.meta.url)` a deleted path. The deleted rows are the
  donor scaffolding cut in extraction Step B7, with its test support,
  assets and seeds.

Operator rulings for the extraction ([extraction](extraction.md)) allow the
companion's local classifier and logger (`@huggingface/transformers` with
`onnxruntime-*`, `winston`) and make the Automata Bus and `SubstrateAgent`
core, so those names are not excluded. The extracted tree keeps donor names
verbatim, so the name rule covers Lite's own code and the deletion record
covers `packages/companion`.

Identifiers are split into words, so `LoopUsage` is not "opus" and
"discharged" is not "charge". Comments that cite donor paths for provenance
are not imports and are not flagged. A first block of tests checks the
checker itself on positive and negative cases.

## Findings

These are donor behaviours that the scenarios pin. They are by design, and
Lite does not change them:

- **The workspace must be the companion's own.** Before Step C gave the
  runtime an explicit `workspaceDir`, the donor fell back to `./workspace`
  of the working directory. Runs then shared one workspace, and a journal
  read showed another run's note. The config now requires a workspace
  outside `dataDir`, and every scenario run gets its own workspace
  ([extraction](extraction.md#seams-and-host-choices)).
- **Orientation is per conversation.** `orient.append` writes the human
  block of the conversation it runs in, and another session of the same
  contact does not see it. A concern scoped to the operator (`contactId`,
  `sensitivity: personal`) is visible across the operator's sessions and
  hidden from the friend. A concern without a `contactId` is global, so the
  friend sees it too. The Hermes e2e seed therefore writes a contact-scoped
  concern.
- **Confidential memories need salience.** The donor's writer drops a
  confidential `memory.write` below its salience threshold, so scenario 03
  writes it at importance 0.9.
- **Journal notes belong to their conversation.** A friend's
  `journal.read` of the operator's conversation note is an error (`Journal
  note not readable from this conversation`).
- **History is stamped.** The donor prefixes earlier user messages in the
  context with their time (for example `[Sun 11-08-26 22:15]`), so `sees`
  and `speech` checks match substrings, not whole messages.

## Limitations

- The model is scripted. These runs prove the runtime's continuity
  contract, not how a real model uses the tools.
- The TypeScript Hermes protocol driver stands in for the plugin. Its `seen`
  is the bridge context, and the real Hermes runner checks what Hermes
  actually sends.
- The real Hermes runner runs both profiles in one Python process. It ends
  one profile's plugin before it loads the other's, because Hermes keeps a
  plugin manager per home and the plugin registers its hooks once per
  process. A Hermes process death (02) drops the plugin's state and keeps
  its ledger. At the next Hermes turn, the successor runs the plugin's own
  recovery, which settles the dead process's turn as failed
  (`hermes_process_ended`) before it prepares. So the runner cannot observe
  a dead turn still holding the conversation (`turn_already_open`), and
  scenario 02 does not assert it.
- Scenario 02 waits out a real host-turn timeout (4 s in the conformance
  config), plus the time the donor takes to record the failed turn.
- What a host-driven turn cannot reproduce in general is listed in
  [extraction](extraction.md#what-a-host-driven-turn-cannot-reproduce).
