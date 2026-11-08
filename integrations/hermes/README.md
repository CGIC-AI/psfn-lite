# psfn_lite: native Hermes plugin for PSFN Lite

This plugin makes PSFN Lite the companion's one authoritative continuity
inside [Hermes](https://github.com/NousResearch/hermes-agent). Every root
Hermes turn is prepared, settled and, before compaction, checkpointed through
the Lite lifecycle bridge. The companion's governed tools (orientation,
memory, sessions, episodes, journals, contacts, emotion, concerns, values,
activity, automata, free time) come from the Lite MCP server through Hermes's
own MCP client. Hermes's built-in memory files are switched off.

Tested against Hermes revision `f0187332d13679e2ace74d1f0eb399eb91a90571`
(recorded in `psfn_lite/config.py` as `HERMES_REVISION` and in
`docs/provenance.md`). The host contract tests refuse to run against any
other revision.

## What happens on a turn

| Hermes hook | What the plugin does |
| --- | --- |
| `pre_llm_call` | First settles, as failed (`hermes_turn_unfinished`), any turn of the same conversation still open: several Hermes failure paths return without `on_session_end`. Then prepares the Lite turn. The idempotency key is derived from the Hermes session and turn ids, so a retried call resumes the same Lite turn, and a prepare whose answer was lost is sent once more under the same key. The plugin then injects Lite's context into the user message as labelled blocks. |
| `pre_tool_call` | Blocks every `mcp__psfn_lite__*` call that is not inside an open Lite turn of this process. Hermes's MCP client sends the standing credential on every call, whoever the turn is for, so this gate is what keeps unbound senders, subagents, the background review, and cron or flush agents out of Lite. |
| `post_tool_call` | Counts the turn's `mcp__psfn_lite__*` calls, which Lite uses as an emotion signal. |
| `post_llm_call` | Keeps the turn's final reply. |
| `on_session_end` | Settles the turn with what actually happened: `completed` with the reply; `interrupted`; `failed` with Hermes's exit reason; or `failed` / `hermes_no_reply` when Hermes completed without a reply. Open turns are keyed by Hermes's turn id, so a compression that rotates the session id mid-turn does not lose the turn. |
| `on_session_finalize` | Settles, as failed (`hermes_turn_unfinished`), any turn still open in the session Hermes closed (exit, `/new`, expiry). |
| `subagent_start` | Marks the child session. Subagent turns and the background review fork never become Lite turns, in a delegated internal-turn process too. |
| memory provider `on_session_switch` | Links a compression's new session id to the one it continues, so the conversation's open turns and checkpoint list follow it. |
| memory provider `on_pre_compress` | Asks Lite to prove every Lite turn of the session is in canonical history. It raises otherwise, so Hermes keeps the uncompressed transcript. |

`on_session_end` is not sent on every exit at the tested revision. Hermes
fires it only from `finalize_turn`, and several failure paths in
`agent/conversation_loop.py` return before it, among them a non-retryable
provider error, exhausted retries and truncation. Those turns are settled as
`failed` / `hermes_turn_unfinished` when the next turn of the conversation
starts or the session is closed. The settlement is logged, reported through
the warning callback and named in the next turn's context. If Hermes reports
the turn's end later, the late report is logged and reported too, and Lite
keeps the failure.

The bearer credential identifies the caller. No request body names a caller,
contact, audience or speaker. One credential speaks for one Lite principal
binding, so `senders` lists the Hermes `(platform, sender_id)` pairs that
binding stands for. A turn from any other sender is not prepared. Its
context tells it that the conversation is not bound to the companion's
continuity, and the `pre_tool_call` gate refuses its Lite tool calls, so
nothing from it reaches Lite. Subagents, the background review fork, and cron
and flush agents cannot use Lite tools either, even in a bound conversation:
delegated work that needs Lite belongs in Lite's own workers (automata).

Context blocks use the same labels as Lite's native Pi harness:
`[participant speech]`, `[your own earlier reply]`, `[system note: ...]` and
`[internal signal: ...]`. Any line of content that starts with `[` is escaped
as `\[`. Self-state and recent activity are never rendered as speech. History
entries of turns the Hermes session already holds are left out. When the
context exceeds `max_context_chars`, the oldest history is dropped and the
block says so.

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
settlement that could not be delivered is kept in that row with its outcome.
The plugin retries it before the next turn is prepared, and compaction is
refused until Lite has it. If Lite never answered the turn's prepare, the
settlement first prepares the same key again. Lite then resumes the turn if
the first prepare reached it. Otherwise Lite records the turn late, with the
message Hermes ran it on and the outcome it actually had, and its trigger is
then later in the archive than the turns that followed.

When a standing Hermes process of the profile starts, it settles as failed
(`hermes_process_ended`) the `turn` rows of exited processes, using the
exited process's host instance, which is the owner Lite checks. Rows of a
live process are left alone. A delegated internal-turn process's rows are
dropped with a warning, because Lite settles that turn itself when the
turn's host releases it or the run times out.

Other failures stay in the ledger as diagnostic rows, without any chat text.
To inspect the ledger, run
`sqlite3 $HERMES_HOME/psfn-lite/undelivered.sqlite3 'select sequence,kind,session_id,turn_id,error from events'`.
Delete diagnostic rows once you have dealt with them. Leave `turn` and
`settle` rows alone: the plugin delivers and removes them.

## Install

1. Run Lite with the MCP transport and the lifecycle bridge configured. In the
   standalone config, set `mcp` (a binding for this Hermes profile's
   credential) and `lifecycle`. Then run `npm run standalone -- serve --config <file>`.
2. Copy `psfn_lite/` to `$HERMES_HOME/plugins/psfn_lite/`. The plugin uses only
   the standard library and Hermes itself.
3. Put the credential in an environment variable that Hermes inherits, for
   example `PSFN_LITE_TOKEN`. The credential is never written to a file in the
   profile.
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
   `memory.user_profile_enabled` and `compression.checkpoint_required` are set
   as shown, the provider refuses to start. The lifecycle hooks also refuse to
   drive any Lite turn, and they say so in the turn's context. Hermes only
   logs a provider that fails to start, so the hooks enforce this themselves.
   While the plugin is not usable, `pre_tool_call` blocks the Lite MCP tools.
   If `psfn-lite.json` itself cannot be read, the plugin cannot tell which MCP
   server is Lite's, so it blocks every MCP tool.
5. Write `$HERMES_HOME/psfn-lite.json`. Every field is required and unknown
   fields are refused:

   ```json
   {
     "bridge_url": "http://127.0.0.1:<lifecycle port>/lifecycle/v1",
     "credential_env": "PSFN_LITE_TOKEN",
     "mcp_server": "psfn_lite",
     "senders": [{ "platform": "cli", "sender_id": "" }],
     "timeout_seconds": 30,
     "max_context_chars": 9000,
     "internal_turns": null
   }
   ```

## Internal turns (free time, scheduled prompts)

With `lifecycle.internalTurns` set to `{"kind": "delegated", "host": "<this
profile's principal>", ...}` in Lite, and `internal_turns` set in
`psfn-lite.json`:

```json
"internal_turns": {
  "command": ["hermes", "chat", "-Q", "--query-file", "{prompt_file}"],
  "poll_wait_ms": 25000,
  "run_timeout_seconds": 600
}
```

the one Hermes process started with `PSFN_LITE_INTERNAL_HOST=1`, normally the
gateway, claims each internal turn and runs it as its own Hermes process.
That process gets the credential Lite minted for that one turn, in place of
the standing credential and through the same `credential_env` variable. Its
MCP tools and lifecycle calls therefore act in the companion's own self
audience. The process also gets `PSFN_LITE_INTERNAL_JOB=1`, so its plugin
prepares the internal trigger Lite fixed, rather than treating the prompt as
participant speech. In that process only the root turn drives Lite and may
use its tools. Subagents, the review fork, and cron or flush agents are
skipped there too, so a child's reply is never recorded as the companion's
internal turn. If a run fails, times out or exits without settling, it is
released to Lite, which records the turn as failed.

Worker runs (automata) stay on the Lite runtime's own worker host.

## Tests

The tests live in `tests/` and run in a project-local virtualenv. Hermes is
installed editable from a throwaway clone at the tested revision. For the
exact commands, see `docs/development.md`.

- `test_config.py` checks strict configuration.
- `test_host_contract.py` runs the plugin inside the pinned Hermes against a
  scripted bridge: discovery through the memory slot, hooks registered once,
  labelled context, every outcome, review and subagent guards, unbound
  senders, undeliverable events, compaction refusal, ownership checks, and
  internal turns.
- `test_turn_integrity.py` also runs inside the pinned Hermes against the
  scripted bridge. It covers a real `AIAgent.run_conversation` that fails
  with HTTP 403 and never fires `on_session_end`, a session closed with a
  turn still open, session rotation mid-turn, a lost prepare answer, a
  prepare Lite never answered, restart recovery, a subagent inside an
  internal turn, and the `pre_tool_call` gate, through Hermes's
  `resolve_pre_tool_block`.
- `test_e2e_lite.py` runs Hermes's real MCP client and the plugin against a
  real Lite runtime over a throwaway Postgres
  (`tests/hermes/fixtures/lite-host.ts`). It covers journals, memory,
  automata, free time and activity tools, called through Hermes's
  `handle_function_call` inside open turns. It also covers tool calls refused
  outside a bound turn, cross-surface activity that only an authorized contact
  sees, archived outcomes, a turn Hermes never ended, a rotated session, a
  lost prepare answer, and compaction. It needs Docker
  and Node, like the TypeScript integration suites.
  `LITE_SKIP_DOCKER_TESTS=1` opts out explicitly.

## Known limits

- Hermes reports no partial reply for an interrupted or failed turn, so those
  turns are recorded with `partialReply: null`. Delivery happens after the
  hook, so it is recorded as `unknown`.
- One Lite turn may be open per Hermes host instance and Lite conversation.
  Two Hermes sessions bound to the same Lite principal (for example the CLI
  and Telegram at once) share one Lite conversation. A turn in one while a
  turn in the other is open is refused by Lite (`turn_already_open`), and the
  refusal is named in that turn's context. The plugin never settles another
  session's running turn to make room.
- If Hermes reports a turn's end only after the next turn of the conversation
  started, the turn is already recorded as `hermes_turn_unfinished`. The late
  report is logged and reported, not applied.
- A dead process's open turns are settled only when a standing process of the
  same profile starts. Until then, Lite recovers such a turn once its lease
  expires, when another owner prepares in that conversation.
