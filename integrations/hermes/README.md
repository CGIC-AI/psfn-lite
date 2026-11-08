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
| `pre_llm_call` | Prepares the Lite turn. The idempotency key is derived from the Hermes session and turn ids, so a retried call resumes the same Lite turn. The plugin then injects Lite's context into the user message as labelled blocks. |
| `post_tool_call` | Counts the turn's `mcp__psfn_lite__*` calls, which Lite uses as an emotion signal. |
| `post_llm_call` | Keeps the turn's final reply. |
| `on_session_end` | Settles the turn with what actually happened: `completed` with the reply; `interrupted`; `failed` with Hermes's exit reason; or `failed` / `hermes_no_reply` when Hermes completed without a reply. |
| `subagent_start` | Marks the child session. Subagent turns and the background review fork never become Lite turns. |
| memory provider `on_pre_compress` | Asks Lite to prove every Lite turn of the session is in canonical history. It raises otherwise, so Hermes keeps the uncompressed transcript. |

The bearer credential identifies the caller. No request body names a caller,
contact, audience or speaker. One credential speaks for one Lite principal
binding, so `senders` lists the Hermes `(platform, sender_id)` pairs that
binding stands for. A turn from any other sender is told in its context that
the conversation is not bound to the companion's continuity, and nothing from
it reaches Lite.

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

A settlement that could not be delivered is kept with its outcome. The plugin
retries it before the next turn is prepared, and compaction is refused until
Lite has it. Other failures stay in the ledger as diagnostic rows, without any
chat text. To inspect the ledger, run
`sqlite3 $HERMES_HOME/psfn-lite/undelivered.sqlite3 'select * from events'`.
Delete rows once you have dealt with them.

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
participant speech. If a run fails, times out or exits without settling, it is
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
- `test_e2e_lite.py` runs Hermes's real MCP client and the plugin against a
  real Lite runtime over a throwaway Postgres
  (`tests/hermes/fixtures/lite-host.ts`). It covers journals, memory,
  automata, free time and activity tools, cross-surface activity that only an
  authorized contact sees, archived outcomes and compaction. It needs Docker
  and Node, like the TypeScript integration suites.
  `LITE_SKIP_DOCKER_TESTS=1` opts out explicitly.

## Known limits

- Hermes reports no partial reply for an interrupted or failed turn, so those
  turns are recorded with `partialReply: null`. Delivery happens after the
  hook, so it is recorded as `unknown`.
- One Lite turn may be open per Hermes host instance and conversation. A
  second concurrent root turn in the same Hermes session is refused by Lite
  (`turn_already_open`), and the refusal is named in that turn's context.
- A Hermes process that dies mid-turn leaves its Lite turn open. The next
  process has a new host instance and recovers the turn once its lease
  expires; Lite records it as interrupted by the host.
