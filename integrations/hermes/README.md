# psfn_lite: native Hermes plugin for PSFN Lite

This plugin makes PSFN Lite the companion's one authoritative continuity
inside [Hermes](https://github.com/NousResearch/hermes-agent). Every root
Hermes turn of a bound sender becomes a host-driven turn of the companion
core, the extracted PSFN donor core. Lite assembles the turn's context, runs
every companion tool call in the donor's own tool loop, archives the turn
and runs its post-turn work. Hermes's model supplies the answers. The turn
is prepared, settled and, before compaction, checkpointed through the Lite
lifecycle bridge. The companion's tools are the donor's catalog (identity,
session, letter, contact, orient, subagent, memory, scratchpad, journal,
schedule, north_star, toolset, tool_search, response_control). They come
from the Lite MCP server through Hermes's own MCP client. Hermes's built-in
memory files are switched off.

Tested against two Hermes revisions, recorded in `psfn_lite/config.py` as
`HERMES_REVISIONS` and in `docs/provenance.md`:

- `f0187332d13679e2ace74d1f0eb399eb91a90571`, where every Hermes process
  serves one profile;
- `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`, where `hermes chat` runs
  through a gateway process and one gateway can serve several profiles
  (see [Hermes with a gateway](#hermes-with-a-gateway-2bd378e)).

The host contract tests refuse to run against any other revision.

## What happens on a turn

| Hermes hook | What the plugin does |
| --- | --- |
| `pre_llm_call` | First settles, as failed (`hermes_turn_unfinished`), any turn of the same conversation that is still open: several Hermes failure paths return without `on_session_end`. Then it prepares the Lite turn in the conversation's Lite session. That session is the Hermes session id the conversation started with, kept across compressions. The idempotency key comes from the Hermes session and turn ids, so a retried call resumes the same Lite turn, and a prepare whose answer was lost is sent once more under the same key. The plugin then injects the donor's context into the user message as labelled blocks. |
| `pre_tool_call` | Blocks every `mcp__psfn_lite__*` call that is not inside an open Lite turn of this process. Hermes's MCP client sends the standing credential on every call, whoever the turn is for. This gate is what keeps unbound senders, subagents, the background review, and cron or flush agents out of Lite. A companion memory delete (`memory`, `action: delete`) inside the turn goes to Hermes's human approval gate (`approve`): once, session, always or deny. A denial or a timeout blocks the call, and the memory stays. |
| `llm_request` middleware | Holds Hermes's model to the companion's explicit tool request (below). |
| `post_tool_call` | After any Lite tool call, marks the turn's tool choice for asking again (below). After an approved memory delete ran, approves in Lite the deletion proposal that call created (`memory-deletion/approve`). Lite accepts it once, only from the turn that made the call. If the call changed, the turn ended or Lite refused, the memory is kept and the next turn's context says so. |
| `post_llm_call` | Keeps the turn's final reply. |
| `on_session_end` | Settles the turn with what actually happened: `completed` with the reply; `interrupted`; `failed` with Hermes's exit reason; or `failed` / `hermes_no_reply` when Hermes completed without a reply. Open turns are keyed by Hermes's turn id, so a compression that rotates the session id mid-turn does not lose the turn. |
| `on_session_finalize` | Settles, as failed (`hermes_turn_unfinished`), any turn still open in the session Hermes closed (exit, `/new`, expiry). |
| `subagent_start` | Marks the child session. Subagent turns and the background review fork never become Lite turns. |
| memory provider `on_session_switch` | Links a compression's new session id to the one it continues, so the conversation keeps its Lite session, its open turns and its checkpoint list. Only `reason: compression` is linked: `/new` starts another conversation, and `/branch` forks one that may stay live beside the original. A hook that arrives for an open turn under a different session id is linked the same way. |
| memory provider `on_pre_compress` | Asks Lite to prove that every Lite turn of the session is in the donor's archive. If Lite cannot, the hook raises, and Hermes keeps the uncompressed transcript. |

`on_session_end` is not sent on every exit at the tested revision. Hermes
fires it only from `finalize_turn`. Several failure paths in
`agent/conversation_loop.py` return before that, among them a non-retryable
provider error, exhausted retries and truncation. Those turns are settled
as `failed` / `hermes_turn_unfinished` when the next turn of the
conversation starts or the session is closed. The settlement is logged,
reported through the warning callback and named in the next turn's
context. If Hermes reports the turn's end later, the late report is logged
and reported too, and Lite keeps the failure.

When the participant asks for tools by name ("call tool_search for the
weather, then orient"), the donor holds every model call of the turn to that
request: exactly the next requested tool while the sequence runs, then no
tool at all. Its stream adapter fails the turn on any other answer
(`tool_contract_incompatible`). Lite hands the choice over: `prepare`'s
context carries the first call's `toolChoice`, and after each Lite tool call
the plugin asks the bridge (`tool-choice`) for the next one. The plugin's
`llm_request` middleware rewrites Hermes's provider request with it, as the
donor's provider client did: only the requested tool, with a required
choice (and, when the participant gave the call's exact arguments, the
donor's exact-arguments schema), or no tool. It does this for the
`chat_completions`, `codex_responses` and `anthropic_messages` API modes;
for an Anthropic forced step it also drops extended thinking, which
Anthropic refuses with a forced tool. On any other API mode, or when the
requested tool is not in Hermes's request, the request goes unchanged and
the next turn's context says so. Hermes's own tools are not offered on a
forced step, as the donor offered only the one tool.

Lite can also end a turn itself before asking Hermes's model, for example
when the donor decides on no reply. `prepare` then answers `answered`. The
turn is recorded with the donor's own outcome, and the context tells the
model that nothing it replies is recorded.

The bearer credential identifies the caller. No request body names a
caller, contact, audience or speaker. One credential speaks for one Lite
principal binding, so `senders` lists the Hermes `(platform, sender_id)`
pairs that binding stands for. A turn from any other sender is not
prepared. Its context tells it that the conversation is not bound to the
companion's continuity, and the `pre_tool_call` gate refuses its Lite tool
calls, so nothing from it reaches Lite. Subagents, the background review
fork, and cron and flush agents cannot use Lite tools either, even in a
bound conversation. Delegated work that needs the companion belongs in the
companion's own bounded subagents (the `subagent` tool).

The context is the donor's assembled model request, rendered as blocks:

- `[system note: companion context]`: the donor's system prompt;
- `[participant speech]`: a user-role message;
- `[your own earlier reply]`: an assistant message;
- `[tool result: <tool>]`: a tool result.

Plugin notes are `[system note: psfn_lite]`. Any line of content that
starts with `[` is escaped as `\[`. Hermes appends the context to the
participant's message, which it sends unlabelled and as written. So the
first block states that the text before it is the participant's own
message, label-like lines included. The final user message of the donor's
context is this turn's own message. Hermes shows it to the model itself, so
it is not repeated. When the context exceeds `max_context_chars`, the
oldest history is dropped first, and the block says so.

## Failures are visible

A lifecycle event that Lite did not accept goes to four places:

- the Hermes log, at error level;
- the profile's ledger, `$HERMES_HOME/psfn-lite/undelivered.sqlite3`
  (owner-only, bound to one bridge URL);
- the memory provider's warning callback;
- a `[system note: psfn_lite]` block in the next turn's context.

Every Lite turn gets a `turn` row in the ledger before it is prepared. The
row holds the prepare body, including the participant's message, and the
owning host instance. It is deleted once Lite has the turn's outcome. A
settlement that could not be delivered stays in that row with its outcome.
The plugin retries it before the next turn is prepared, and compaction is
refused until Lite has it. If Lite never answered the turn's prepare, the
settlement first prepares the same key again. If the first prepare reached
Lite, Lite resumes that turn. Otherwise Lite records the turn late, with the
message Hermes ran it on and the outcome it actually had.

When a standing Hermes process of the profile starts, it settles as failed
(`hermes_process_ended`) the `turn` rows of exited processes. It uses the
exited process's host instance, which is the owner Lite checks. Rows of a
live process are left alone.

Other failures stay in the ledger as diagnostic rows, without any chat text.
To inspect the ledger, run
`sqlite3 $HERMES_HOME/psfn-lite/undelivered.sqlite3 'select sequence,kind,session_id,turn_id,error from events'`.
Delete diagnostic rows once you have dealt with them. Leave `turn` and
`settle` rows alone: the plugin delivers and removes them.

## Install

1. Run Lite with the MCP transport and the lifecycle bridge configured. In
   the standalone config, set `mcp` (a binding for this Hermes profile's
   credential) and `lifecycle`. Set `lifecycle.hermesInstallId` to this
   Hermes install's id: the content of the file `install_id` in the Hermes
   root (`~/.hermes/install_id` by default). Hermes creates that file when
   its dashboard first starts (f0187332) or when anything first asks for its
   install identity (2bd378e). Use `"sessionIntegrity": {"kind": "keyring"}`
   with the session keyring in the environment
   (`GATEWAY_SESSION_HMAC_KEYS`), so the journals are signed. Then run
   `npm run standalone -- serve --config <file>`.
2. Copy `psfn_lite/` to `$HERMES_HOME/plugins/psfn_lite/`. The plugin uses
   only the standard library and Hermes itself.
3. Put the credential in the profile's `.env` (`$HERMES_HOME/.env`), for
   example `PSFN_LITE_TOKEN=...`. The plugin and Hermes's MCP client read it
   through Hermes's profile secret scope. A Hermes gateway clears the
   environment it inherited and loads each profile's `.env` on its own, and
   a multiplexing gateway refuses a secret read outside a profile's scope,
   so a variable exported in the shell does not reach a gateway-run turn.
   Keep the `.env` owner-only; the credential is never written to any other
   file in the profile.
4. Add to `$HERMES_HOME/config.yaml`:

   ```yaml
   memory:
     provider: psfn_lite
     memory_enabled: false        # Lite is the only memory
     user_profile_enabled: false
   compression:
     checkpoint_required: true    # compaction must not drop unproven turns
   hooks:
     output_spill:
       max_chars: 10000           # at least max_context_chars, so context is not spilled to a file
   mcp_servers:
     psfn_lite:
       url: http://127.0.0.1:<mcp port>/mcp
       headers:
         Authorization: "Bearer ${PSFN_LITE_TOKEN}"
       timeout: 30
   ```

   Unless `memory.provider`, `memory.memory_enabled`,
   `memory.user_profile_enabled` and `compression.checkpoint_required` are
   set as shown, the provider refuses to start. The lifecycle hooks also
   refuse to drive any Lite turn, and they say so in the turn's context.
   Hermes only logs a provider that fails to start, so the hooks enforce
   this themselves. While the plugin is not usable, `pre_tool_call` blocks
   the Lite MCP tools. If `psfn-lite.json` itself cannot be read, the plugin
   cannot tell which MCP server is Lite's, so it blocks every MCP tool.
   A profile that does not select `psfn_lite` is never touched: the hooks
   leave its turns and its MCP tools alone, even in a gateway process that
   also serves a Lite profile.
   The plugin also needs the Hermes install id, one per Hermes install and
   shared by every profile. At 2bd378e it is read through Hermes's own
   `hermes_cli.install_identity.get_install_id`, which creates the id once
   if it is missing. At f0187332 the plugin reads the file and never creates
   it. Without the id, or when Lite is bound to another install
   (`wrong_install`), no Lite turn is driven and the Lite tools are blocked.
5. Write `$HERMES_HOME/psfn-lite.json`. Every field is required, and unknown
   fields are refused:

   ```json
   {
     "bridge_url": "http://127.0.0.1:<lifecycle port>/lifecycle/v1",
     "credential_env": "PSFN_LITE_TOKEN",
     "mcp_server": "psfn_lite",
     "senders": [{ "platform": "cli", "sender_id": "" }],
     "timeout_seconds": 30,
     "max_context_chars": 9000,
     "automata": null
   }
   ```

   `senders` names the Hermes `(platform, sender_id)` pairs this credential
   speaks for. The local CLI is `{"platform": "cli", "sender_id": ""}` when
   `hermes chat` runs its own agent (f0187332). Through the gateway
   (2bd378e) it is `{"platform": "local", "sender_id": "uid:<uid>"}`, where
   `<uid>` is the numeric id of the OS user the gateway runs as (`id -u`);
   the gateway accepts local connections only from that user.

## Hermes with a gateway (2bd378e)

At 2bd378e `hermes chat` connects to a gateway process instead of running
the agent itself, and the root gateway can serve several profiles at once.
The plugin keeps everything per profile home: each profile's hooks and
middleware sit in that profile's Hermes plugin manager, and each profile has
its own driver, ledger, host instance, credential and warning callback.

- **The credential comes from the profile's `.env`**, as step 3 says.
- **A new profile is adopted by the root gateway.** The root multiplexing
  gateway serves every profile that does not set `gateway.standalone: true`
  in its `config.yaml` (`hermes_cli/profiles.py`). A Lite profile served
  that way shares the gateway process with the others; that is supported.
  Set `gateway.standalone: true` to give the profile its own gateway
  instead.
- **Plugin isolation.** The plugin is tested in process
  (`plugins.isolation: in_process`, Hermes's default). Hermes's
  `plugins.isolation: host` mode, which runs plugin code in a separate host
  process, is not tested.

## Hosted automata

The companion's automata (bounded workers it spawns) normally run in Lite's
core. With hosted automata they run as this Hermes's own subagents:

1. In the standalone config, set `lifecycle.automata` to
   `{"maxAttempts": 3, "leaseMs": 60000, "maxIterations": 250}` (the
   attempts a task gets, how long an attempt lives without a heartbeat, and
   the largest per-attempt iteration budget a host may declare). Hermes
   gives every lifecycle child 250 iterations and has no per-launch budget,
   so a `maxIterations` below 250 refuses Hermes's claims.
2. In `psfn-lite.json`, set `"automata": {"claim_limit": 2}` (attempts
   claimed per root turn, 1 to 8). The credential must belong to a
   principal bound to Lite's primary contact; only it runs automata.
3. Enable the `psfn_lite` toolset for the profile's agents (or leave
   toolsets unrestricted). A child inherits its parent's toolsets, and the
   `automata_bus` tool, the child's only way to persist, is in that toolset.

At the start of each bound root turn, the plugin claims the waiting
attempts and launches one child per attempt through Hermes's
`ctx.subagent_lifecycle`. Each attempt has its own credential, which the
plugin holds in memory only. The child's `automata_bus` calls go to Lite
under that credential. The plugin renews the attempt while the child runs,
stops the child when Lite asks, and reports how it ended. If Hermes loses
the child, or the process exits, the attempt ends as lost and Lite queues
the next attempt, up to `maxAttempts`. A write the next attempt repeats is
the same Bus event. Limits are listed in `docs/extraction.md` (Operator
automata rules).

## Tests

The tests live in `tests/` and run in a project-local virtualenv. Hermes is
installed editable from a throwaway clone at the tested revision. For the
exact commands, see `docs/development.md`.

- `test_config.py` checks strict configuration.
- `test_host_contract.py` runs the plugin inside the pinned Hermes against
  a scripted bridge. It covers discovery through the memory slot, hooks
  registered once, labelled context, every outcome, review and subagent
  guards, unbound senders, undeliverable events, compaction refusal and
  ownership checks, and the memory delete approval (the `approve`
  directive, the resolve after an approved call, nothing after a blocked
  one).
- `test_turn_integrity.py` also runs inside the pinned Hermes against the
  scripted bridge. It covers:
  - a real `AIAgent.run_conversation` that fails with HTTP 403 and never
    fires `on_session_end`;
  - a session closed with a turn still open;
  - session rotation mid-turn (both turns stay in the root Lite session);
  - a lost prepare answer, and a prepare Lite never answered;
  - restart recovery;
  - the `pre_tool_call` gate, through Hermes's `resolve_pre_tool_block`.
- `test_tool_choice.py` runs the `llm_request` middleware through Hermes's
  own `apply_llm_request_middleware`: the forced step, the step after it,
  each supported API mode, the exact-arguments schema, and the requests it
  must leave alone.
- `test_profiles.py` runs two Lite profiles and one non-Lite profile in one
  process, as the 2bd378e gateway does (home override and profile secret
  scope per turn, multiplexing on): hooks, host instance and credential per
  profile, one install id, the gateway's `local` / `uid:<uid>` sender, and
  a non-Lite profile left alone.
- `test_e2e_lite.py` runs Hermes's real MCP client and the plugin against
  a real Lite runtime over a throwaway Postgres
  (`tests/hermes/fixtures/lite-host.ts`, the conformance host). It covers:
  - donor tools called through Hermes's `handle_function_call` inside open
    turns;
  - tool calls refused outside a bound turn;
  - a thread the standalone's own turn wrote, seen in a Hermes turn and
    hidden from a contact it is not disclosed to;
  - settled outcomes in the donor's history;
  - a turn Hermes never ended, a rotated session, a lost prepare answer,
    and compaction;
  - a memory delete through Hermes's CLI approval prompt: a denial keeps
    the memory, an approval deletes it;
  - an explicit tool request: the middleware forces the requested tool,
    then no tool, and Lite records the turn as completed.

  It needs Docker and Node, like the TypeScript integration suites.
  `LITE_SKIP_DOCKER_TESTS=1` opts out explicitly.
- `test_conformance.py` runs the continuity conformance scenarios on the
  real plugin (`docs/conformance.md`).
- `test_hosted_automata.py` runs hosted automata inside the pinned Hermes
  with its real lifecycle service, hooks and tool dispatch, against the
  scripted bridge. Only the child's model loop is replaced. It covers a
  credential and budget per child, lost, failed and cancelled children,
  children running at once, and the Hermes source facts the plugin relies
  on.

## Known limits

The limits of host-driven turns themselves are listed in `docs/extraction.md`
("What a host-driven turn cannot reproduce"). Those that matter most to
Hermes:

- The companion runs one turn at a time. While a Hermes turn is open, a
  turn of another bound principal is refused (`unavailable`,
  `companion_turn`), and so is another turn of the same principal
  (`turn_already_open`). The refusal is named in that turn's context. The
  plugin never settles another session's running turn to make room.
- Hermes delivers its reply after the hook and does not stream it to Lite.
  Lite records the reply as the donor's reply handling leaves it, which may
  differ from what Hermes showed.
- A Lite turn is held to the donor's turn limits (36 assistant steps, 5
  minutes) and to the bridge's `hostTurnTimeoutMs`. If the donor asks for
  another completion after Hermes's final reply, the turn ends failed.
- Hermes reports no partial reply for an interrupted or failed turn, so
  none is recorded.
- An explicit tool request is enforced only on the API modes listed above.
  The donor re-asked its model once when a forced call was missing; a host
  turn cannot be re-asked, so a model that ignores the forced choice fails
  the turn.
- The donor context includes the conversation's earlier turns, and Hermes
  also sends its own transcript, so the model sees earlier turns twice.
- If Hermes reports a turn's end only after the next turn of the
  conversation started, the turn is already recorded as
  `hermes_turn_unfinished`. The late report is logged and reported, not
  applied.
- A dead process's open turn is settled when a standing process of the
  same profile starts. Until then, the bridge's host-turn timeout fails it.
