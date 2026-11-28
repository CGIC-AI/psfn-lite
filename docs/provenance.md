# Source provenance

PSFN Lite is derived from https://github.com/CGIC-AI/psfn-framework at
`e6a9546051f4e92bf7218b133b4523ac53a797c0` (the donor). The companion core
is the pinned npm package `@cgic/psfn-core` (0.1.1), which psfn-framework
builds from its own `src/` and tags `core-v0.1.1` (commit
`51195a85921af8a4f8f39404f12a90b61a08d6a4`). Everything in this repository
is a host adapter written for Lite around that core, or test support.

Until `1e90250` the core was a vendored, path-preserving extraction in
`packages/companion`, with machine-readable records in
`packages/companion/extraction/` and a per-file table here. The last Lite
commit that holds them is `d611e36` (the merge of the light Garden):
`git show d611e36:docs/provenance.md` and
`git show d611e36:packages/companion/extraction/cuts.tsv`. The extraction
record ([extraction](extraction.md)) keeps the narrative: the closure, every
seam cut, every deleted or modified test and the equivalence runs.

How to read the entries:

- **extracted unchanged from `<donor path>`**: the same Git blob as the donor
  file at the same path.
- **written for Lite**: a host adapter. It is not donor code, and it names
  the donor code it fits.
- **cut**: donor code that is not in Lite, or Lite code that a later step
  deleted.

## Bootstrap artifacts

| Lite path | Entry |
| --- | --- |
| `LICENSE` | extracted unchanged from donor `LICENSE` |
| `docs/framework-agent-contract.md` | extracted unchanged from donor `AGENTS.md` (a reference snapshot, not the active Lite operating contract) |

The root `AGENTS.md`, the charter and the other documents are written for
Lite.

## Host adapters (written for Lite)

| Lite path | Entry |
| --- | --- |
| `apps/standalone/src/*` | written for Lite: the Lite config document, the substrate config, the CLI and a thin host over donor `startCompanionRuntime` (the composition root, framework `src/app/companion/runtime.ts` at `core-v0.1.1`, seams 3.1, 3.11, B7, C and D). `session-integrity.ts` scopes the donor session keyring to the bound Hermes install (seam E2; donor `createKeyringIntegrityProvider`, `src/persistence/sessions/store-primitives.ts:144`). `model-usage.ts` is the host's in-memory `ModelUsageRecorder` (seam 3.1, E6, in place of the donor's Postgres model-usage store, `src/persistence/postgres/model-usage-store.ts`, cut). `config.ts` names one of the donor embedding provider kinds (`transformers`, `ollama`, `api`; donor `src/faculties/memory/embedding.ts:29`), default the donor seed's `transformers` (seam S5, superseding S1). `substrate-config.ts` sets the donor embedding fields so the core builds the donor provider itself (donor `createEmbeddingProviderFromConfig`, `embedding.ts:721-734`; seam S5), resolves a relative `textEmotionCacheDir` and embedding `cacheDir` under `dataDir` (seams S2, S5) and assembles the config the way donor `src/system/config/load-config.ts` (`loadAgentConfig`, defaults `:76-129`, assembly `:497-565`) and `settings/runtime.ts` (`applyCoreSettings`) did, for the kept subsystems only. |
| `packages/lifecycle/src/*` | written for Lite: host-driven turns. They go through the donor `SubstrateAgent.handleMessage` and the stream transport seam (donor `src/app/agent/core-runtime.ts:724-726`), on the donor's Hermes channel convention (`externalMemorySessionId`). The donor tool catalog is exposed as MCP tools (donor `tool-runtime-facade` `getToolCatalog`). `memory-deletion.ts` is the host `MemoryDeletionApprovalPort` (seam E3), in place of the donor gateway's confirmation surface (donor `src/app/agent/main.ts:583-603`). `host-turns.ts` hands the host the donor's explicit tool contract per model call (seam S3; donor `src/primitives/llm/explicit-tool-request.ts` `resolveExplicitToolContract`, applied as donor `client-request-capability.ts` `applyExplicitToolChoice` and `buildPiContext` did). |
| `packages/mcp/src/*` | written for Lite against `@modelcontextprotocol/server` 2.3.0, the donor's pinned SDK. It follows the donor's external-memory MCP route (`src/channels/api/server/external-memory-mcp.ts`, cut): a stateless per-request handler, a bearer credential bound to a fixed identity, browser `Origin` and `Mcp-Session-Id` refused. Credentials come from the environment or owner-only files and are compared in constant time against every binding (pattern of donor `src/channels/backplane/http/auth.ts` `isExpectedApiToken`, cut). stdio has no donor counterpart. |
| `packages/pi/src/*` | written for Lite against `@earendil-works/pi-ai` 0.84.1, the donor's pinned version. It holds the model runtime the core's provider port takes, and the adapter (`companionEmbeddingProviderOf`) for a host that supplies its own embedding port; the configured embedding providers are the donor's (seam S5). |
| `packages/operator/src/*` | written for Lite: the light Garden's operator surface (seam S8). `garden.ts` composes the donor Garden services of the eight screens as donor `src/operator/garden/local-admin-contract.ts` did (each step cites its donor lines) over the companion's own stores (`CompanionRuntime.garden`). `donor-routes.ts` compiles the donor route builders against the donor route catalogue, and `http.ts` dispatches them as donor `server-routes.ts:59-100` did, with `createStandaloneGardenRequestContext`. `lite-routes.ts` serves what no kept donor route serves: the Overview and Inner life reads, memory delete and restore and the deletion-proposal decisions (decision a), and Settings through the donor owner-file loaders (decision b). `audit.ts` ports donor `appendGardenEntry` to the same `garden-audit-history.jsonl` record. |
| `integrations/hermes/psfn_lite/*` | written for Lite: the Hermes plugin (below). |
| `integrations/hermes/psfn_lite/dashboard/*`, `integrations/hermes/install_plugin.py` | written for Lite: the dashboard backend, a proxy from Hermes's `/api/plugins/psfn_lite/` to the operator surface, and the install tool that never copies the Desktop half (seam S8). |
| `integrations/hermes/desktop/*`, `integrations/hermes/psfn_lite/desktop/plugin.js` | written for Lite against the Hermes Desktop plugin SDK at 2bd378e: the light Garden in Hermes Desktop, and its committed build (seam S8). It reads and writes the donor Garden routes and the Lite routes; it holds no donor code. The donor Garden client (the Svelte app in the donor repository's `admin-ui/`) is not vendored. |
| `tests/*`, `integrations/hermes/tests/*` | written for Lite: tests of the host adapters, the conformance suite and the Hermes plugin tests. `tests/support/postgres-harness.ts` follows donor `src/test-support/postgres-test-harness.ts`: a pinned pgvector image, tmpfs data, a label, a random port, and removal of exactly its own container. |
| `scripts/bench/footprint.ts` | written for Lite: the install-footprint measurement ([footprint](footprint.md)). |

## The companion core (`@cgic/psfn-core`)

Lite imports the core only through the package's entry points: `.`,
`./lifecycle`, `./operator`, `./ports` and `./seeds`. `./operator` carries
the light Garden's donor services, route builders, request context, stores
and owner-file loaders, re-exported from the framework's own `src/` (most
from `src/operator/garden`); Lite reaches it only through
`packages/operator/src/companion.ts`. A donor cite in Lite code names a
donor path at `e6a9546` unless it names `core-v0.1.1`; a few still name the
vendored tree (psfn-lite-iga). The core's own unit and
package-boundary tests run in psfn-framework before release; Lite runs its
host-adapter, Garden, lifecycle, MCP and conformance suites against the
pinned package ([development](development.md)).

## Cut in Step C (Lite code)

Lite's own companion core and its storage, harness and transport internals
were deleted when Lite moved onto the extracted core. They had been written
new for Lite from the donor's contracts; no donor code was copied into them.
The donor's own implementation replaces each one.

| Lite path (before Step C) | Entry |
| --- | --- |
| `packages/core/src/*` (124 files: the tool inventory, ingress and turn lifecycle, dispatch, privacy, sessions, contacts, identity, memory, episodes, journals, emotion and self-model, concerns, activity, automata, free time, schedule, backup) | cut in Step C; the donor core (now `@cgic/psfn-core`) |
| `packages/adapters/src/*` (32 files: the JSONL session archive and history chain, Postgres stores and migrations 0001-0004, state backup) | cut in Step C; the donor persistence (now in `@cgic/psfn-core`) |
| `packages/pi/src/{companion-harness,loop,context,render,settlement,turn-settler,tools,worker-host,inference}.ts` | cut in Step C; the donor `SubstrateAgent` is the harness |
| `packages/mcp/src/{catalog,schema,results,callers,internal-turns,core}.ts`, `arguments/*` | cut in Step C; the donor tool catalog (`packages/lifecycle/src/tools.ts`) |
| `packages/lifecycle/src/{core,delegated}.ts` | cut in Step C; host-driven turns (`host-turns.ts`, `bridge.ts`) |
| `apps/standalone/src/{adapters,capabilities,core,harness,local-host,stacks,storage,tick-loop,transports}.ts` | cut in Step C; donor `startCompanionRuntime` |
| `integrations/hermes/psfn_lite/internal.py` | cut in Step C, with delegated internal turns |
| `scripts/bench/{inference,latency,lite-host}.ts` | cut in Step C; they measured the Lite runtime |
| `packages/companion/*` (the vendored core, its seeds, `baseline.json` and the `extraction/` records) | cut in `1e90250`; `@cgic/psfn-core` 0.1.1 replaces it |

## Hermes integration

Hermes reference: https://github.com/NousResearch/hermes-agent. The tested
upstream revisions are `f0187332d13679e2ace74d1f0eb399eb91a90571` and
`2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19`. They are recorded as
`HERMES_REVISIONS` in `integrations/hermes/psfn_lite/config.py`, and the
host contract tests refuse any other revision. No Hermes code is copied
into Lite.

The plugin uses these capabilities at both revisions unless a line says
otherwise:

- the memory-slot loader for a user plugin directory (`plugins/memory`
  `load_memory_provider`, exclusive classification), and `register(ctx)`
  forwarding `register_hook` and `register_middleware` to a real
  `PluginContext`. The provider's module is `_hermes_user_memory.psfn_lite`
  at f0187332 (one per process) and
  `_hermes_user_memory.psfn_lite__source_<digest of the plugin directory>`
  at 2bd378e;
- a plugin manager per Hermes home (`hermes_cli/plugins.py`
  `get_plugin_manager`) and the context-local home override
  (`hermes_constants.set_hermes_home_override`) with which a gateway runs a
  profile's turn; the plugin keeps its hooks, drivers and callbacks per
  home;
- the `llm_request` middleware (`hermes_cli/middleware.py`
  `apply_llm_request_middleware`, called before every provider request with
  `turn_id`, `session_id`, `api_mode`, `provider` and `base_url`): a
  `{"request": ...}` result replaces the provider kwargs. The plugin uses it
  for the donor's explicit tool contract, including the thinking fields of
  Hermes's DeepSeek and Kimi provider profiles (`extra_body.thinking`,
  `reasoning_effort`, from `agent/reasoning_effort.py`
  `thinking_toggle_extras`);
- Tool Search (`tools/tool_search.py`, on by default at both revisions):
  MCP tools are deferred behind the `tool_search` / `tool_describe` /
  `tool_call` bridges. The plugin forces a deferred Lite tool through
  `tool_call` (`{calls: [{name, arguments}]}` at 2bd378e, one
  `{name, arguments}` at f0187332), reads the tool's schema from the
  registry (`tools/registry.py` `get_schema`), and relies on Hermes
  unwrapping the bridge call before its hooks and dispatch
  (`agent/tool_executor.py`, `model_tools.py`);
- hooks delivered through `hermes_cli.lifecycle.invoke_hook` with the
  payloads at that revision:
  - `pre_llm_call`: context returned as `{"context": ...}` is injected into
    the user message, and the spill threshold is
    `hooks.output_spill.max_chars`;
  - `post_llm_call`: only on a completed, uninterrupted reply;
  - `pre_tool_call`: a `{"action": "block", "message": ...}` result vetoes
    the call. A callback that raises does not, so the plugin never raises
    there. An `{"action": "approve", "message": ..., "rule_key": ...}`
    result sends the call to the human approval gate
    (`hermes_cli/plugins.py` `_resolve_block_from_details`,
    `tools/approval.py` `request_tool_approval`: once, session, always or
    deny; a denial, a timeout or a gate failure blocks the call). The plugin
    uses it for the companion's memory delete. A blocked call returns before
    dispatch (`model_tools.py` `_pre_dispatch_guards`;
    `agent/tool_executor.py` `_dispatch_authorized_once`), so Hermes's MCP
    circuit breaker (`tools/mcp_tool.py` `_server_error_counts`, counted
    only in `tools/mcp_tool_handlers.py`) never counts it; the plugin relies
    on that to check a forced step's call and to block Lite's tools after
    the companion's turn ended (seam S7). Hermes has no hook result that
    stops a turn in progress (`pre_llm_call`'s block applies only before the
    turn's loop);
  - `post_tool_call`: with `args`, `result`, `tool_call_id` and `status`
    (`ok`, `error` or `blocked`), also fired for a blocked call;
  - `on_session_end`: with `completed`, `failed`, `interrupted` and
    `turn_exit_reason`, fired only from `finalize_turn`. Several failure
    paths of `agent/conversation_loop.py` return without it, which
    `tests/test_turn_integrity.py` reproduces with a real
    `AIAgent.run_conversation`;
  - `on_session_finalize` and `subagent_start`;
- the turn id minted once per turn in `agent/turn_context.py`. It is
  unchanged when a compression rotates `agent.session_id` mid-turn
  (`agent/conversation_compression.py`). `MemoryProvider.on_session_switch`
  reports that rotation;
- the install id Hermes keeps in its root (`get_default_hermes_root()/install_id`,
  32 hex characters), one per install and shared by every profile. At
  2bd378e the plugin reads it through `hermes_cli/install_identity.py`
  `get_install_id`, which creates it once if it is missing. At f0187332 the
  only reader is `hermes_cli/web_server.py` `get_install_id` (the dashboard
  server), so the plugin reads the file itself and never creates it;
- the profile secret scope (`agent/secret_scope.py` `get_secret`): the
  bridge credential is read through it, so a gateway turn gets its
  profile's `.env` value, and a multiplexing gateway without a scope fails
  closed (`UnscopedSecretError`);
- the local CLI sender: platform `cli` with sender `""` at f0187332;
  platform `cli` with sender `uid:<uid>` at 2bd378e, where `hermes chat`
  goes through the gateway's control socket
  (`gateway/control_socket.py` `_posix_peer_subject`) and the gateway maps
  its `Platform.LOCAL` source to `cli` (`gateway/run_turn_runner.py`
  `platform_key`);
- `MemoryProvider` checkpoint API v2, with `MemoryManager.on_pre_compress(...,
  require_checkpoint=True)` propagating the refusal;
- MCP servers from `config.yaml` `mcp_servers`, with `${VAR}` header
  interpolation, through `discover_mcp_tools` (`tools/mcp_tool.py` at
  f0187332, `tools/mcp_tool_discovery.py` at 2bd378e) and the tool
  registry, against Lite's stateless streamable HTTP endpoint.

The donor's `integrations/hermes-memory` (`psfn_memory/provider.py`,
`outbox.py`, `config.py`, `plugin.yaml`, `tests/test_host_contract.py` and
`tests/test_provider.py` at the donor revision) was audited. It was a
recall-plus-ingest memory provider over the PSFN gateway's MCP tools. These
patterns from it were rewritten for Lite:

- strict dataclass config parsing, with unknown fields refused
  (`psfn_lite/config.py`);
- the durable SQLite outbox pattern (WAL, `synchronous = FULL`, an
  owner-only file in a 0700 directory, a binding row that refuses a profile
  shared with another target). It became `psfn_lite/ledger.py`, which keeps
  every Lite turn from before its prepare until Lite accepts its outcome;
- server failures classified into diagnostics that never echo server text
  (`psfn_lite/bridge.py`);
- host contract testing by installing the plugin into a throwaway profile
  and loading it through Hermes's real loader.

Not kept from it: recall through `prefetch` (Lite's context arrives with
each prepared turn); `sync_turn` ingestion of completed pairs (Lite settles
every outcome); gateway body and receipt assertions (the bridge binds the
caller from the credential); and Telegram DM identity parsing (senders are
an explicit `(platform, sender_id)` allowlist bound to one credential). The
plugin pins the newer Hermes revisions above, not the donor's
`5bd439d3ed4ae5f099857813383389dcd0ab4369`.
