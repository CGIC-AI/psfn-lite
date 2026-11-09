# Architecture

PSFN Lite is the donor PSFN Framework's companion core plus a small set of
host adapters. The core (`packages/companion`) is the donor's code, extracted
path-preserving from `psfn-framework` at
`e6a9546051f4e92bf7218b133b4523ac53a797c0` with only the recorded seam cuts
([extraction](extraction.md), [provenance](provenance.md)). Everything else
in the repository is a host adapter around that core's composition root,
`startCompanionRuntime`. The adapters define no companion behaviour of their
own.

The earlier direction, before extraction, was to rewrite the core in new
Lite packages and not import `SubstrateAgent` wholesale. Extraction Step C
superseded it. The operator rulings recorded in the extraction make the
`SubstrateAgent` and the Automata Bus core, so the donor's behaviour, tests
and documents are the spec. That earlier core (`packages/core`,
`packages/adapters`) is deleted.

## Layout

| Part | Package | Role |
|---|---|---|
| Companion core | `packages/companion` (`lite-companion`) | The donor core: identity and prompt layers, sessions and the session archive, contacts and trust, memory, episodes, journals, emotion and self-model, concerns and intention, scheduler, automata and bounded subagents, letters, North Star, and the tool registry. The Lite composition root is `src/app/agent/companion-runtime.ts`. |
| Model | `packages/pi` | The Pi model runtime (a pi-ai model collection, one model, the host's key) that the core's provider port takes, and the adapter for a host that supplies its own embedding port. |
| Embeddings | `packages/companion` | The donor's own embedding providers (`src/faculties/memory/embedding.ts`), which the core builds from the substrate config: `transformers` (in-process `@huggingface/transformers`, local and keyless, the default), `ollama` or `api` (docs/extraction.md, "Donor embedding providers restored"). |
| Tool transport | `packages/mcp` | MCP over streamable HTTP or stdio. It serves the donor tool catalog and binds the caller from the transport credential. |
| Lifecycle bridge | `packages/lifecycle` | Host-driven turns for an external host that runs its own model loop: `prepare`, `settle`, `checkpoint`, and the host tool port the MCP transport hands calls to. |
| Standalone host | `apps/standalone` | The config document, the CLI (`init`, `once`, `chat`, `serve`) and the composition of the parts above. |
| Hermes plugin | `integrations/hermes` | A Python Hermes plugin that turns every root Hermes turn into a host-driven Lite turn ([its README](../integrations/hermes/README.md)). |

Each host package reaches the companion core through exactly one module
(`companion.ts`), and another host package only through its public entry.
`tests/boundary/host-imports.test.ts` enforces this, and also that the core
imports no host package and every bare import is a builtin or an exactly
pinned dependency. `tests/conformance/absence.test.ts` keeps the excluded
subsystems out ([conformance](conformance.md)).

## Standalone composition

`createLiteRuntime` (`apps/standalone/src/runtime.ts`) does this:

1. It validates the config document (`config.ts`). The document names the
   host's choices only: `companionId`, `dataDir`, `workspaceDir`, the
   character card, the operator and other contacts, where the database URL
   and the provider keys live (environment variable names), the model, the
   embedding provider (one of the donor kinds; without an `embedding` block
   the donor's seeded default, `transformers` with `Xenova/all-MiniLM-L6-v2`
   at 384 dimensions, cached in `dataDir/models/transformers`),
   session-journal integrity (the donor HMAC keyring, or
   unsigned), and the optional `mcp` and `lifecycle` endpoints. The
   `lifecycle` endpoint names the Hermes install it serves
   (`hermesInstallId`). Unknown keys are refused. Secrets are never in the
   file.
2. It loads the companion's own behaviour from the owner files in
   `dataDir`, with the donor loader (`loadInnerLifeConfig`). `init` seeds
   those files (scheduler, settings, trust policy and the others) from the
   donor's shipped seeds and keeps files that already exist. One of them is
   the capability tier (`capability-tier.json`, donor semantics, read once
   at start). Lite seeds it as `autonomous`, so the model may spawn
   automata; `memory.delete` still only proposes (see Hermes, below).
3. It builds the substrate config the way the donor's `loadAgentConfig` did
   (`substrate-config.ts`): the donor's core defaults, then the scalar
   `settings.json` values, then the host's model, embedding, database and
   paths. Defaults of cut subsystems are not set. A relative
   `textEmotionCacheDir` (the seed's `models/transformers`) or embedding
   `cacheDir` resolves under `dataDir`, never the working directory.
4. It starts the companion with `startCompanionRuntime`. It passes the Pi
   provider runtime (and an embedding provider only when the caller supplies
   its own port; otherwise the core builds the configured donor provider,
   and its fail-closed startup warmup checks it), a model-usage recorder, the
   session integrity provider, an outbound sender (the operator's channel), the path
   snapshot (workspace `workspaceDir`, and logs and temp under `dataDir`)
   and, when a lifecycle bridge is configured, the relay's
   `wrapStreamTransport`. When
   `lifecycle.automata` is set, it also passes a `HostedAutomataExecutor`
   (`packages/companion/src/faculties/subagents/host-execution.ts`), so
   spawned automata run as host attempts that the bridge's `automata/*`
   routes serve. When a lifecycle bridge is configured, it passes the
   memory deletion approval port (`HostMemoryDeletionApprovals`,
   `packages/lifecycle/src/memory-deletion.ts`). Without one, the donor
   `memory` tool's delete answers "not configured".

   Session integrity: with `sessionIntegrity: keyring`, every session
   journal entry carries the donor HMAC chain over the keyring in the
   environment (`GATEWAY_SESSION_HMAC_KEYS`). The entries of a Hermes
   conversation (`api:hermes:` channels) are signed with that keyring
   scoped to the bound Hermes install
   (`apps/standalone/src/session-integrity.ts`), so a journal written for
   another install fails verification. With `unsigned`, the journals are
   the donor's non-production mode: not signed and not verified.

   The model-usage recorder (`model-usage.ts`) is required. The core
   records every model and embedding call through it, and the donor
   `LLMClient` refuses every autonomous (non-foreground) call when there is
   none. The host keeps in-memory totals by lane and by provider/model
   (`LiteRuntime.modelUsage()`). They start at zero on every start; the
   donor's durable usage rows, budgets, alerts and exports are cut. Keeping
   usage in memory is the operator's decision
   ([extraction](extraction.md#e6-model-usage-stays-in-memory)).
5. It provisions the configured contacts in the donor contact store, keyed
   by the host's contact key, and finds them again on every start.
6. It mounts the MCP transport and the lifecycle bridge on loopback, unless
   the config names wider `allowedHosts`.

The donor keeps process-wide state, so a process runs one companion runtime.
Storage is the donor's: PostgreSQL with pgvector in an `extensions` schema
for structured state, and the donor's session archive and file stores under
`dataDir`. The companion's personal workspace (journal and other personal
files) is `workspaceDir`, which must not overlap `dataDir`.

## Two kinds of turn, one companion

**Donor-driven turns.** On `once`, `chat` and the companion's own scheduled
work, the donor `SubstrateAgent` runs the whole turn. It assembles the
context, calls the model through the Pi model port, runs tool calls in its
own loop, and archives the turn and its post-turn work. This is the donor's
behaviour unchanged.

**Host-driven turns.** A host such as Hermes runs its own model loop. The
lifecycle bridge still gives it a donor turn:

1. `prepare` calls `SubstrateAgent.handleMessage` with a `SubstrateMessage`
   built from the credential's principal and its bound contact. The message
   goes on the donor's Hermes channel convention,
   `externalMemorySessionId({bodyId: principal, companionId, contactId},
   sessionId)`. It is a direct message on the `api` channel type, with the
   contact as the canonical contact hint.
2. The donor calls its stream transport for the turn's first completion.
   The relay (`host-turns.ts`, `HostTurnRelay`) wraps the default transport
   and recognises its own turns by the request id the donor stamps on each
   call's correlation. It holds that call and returns the call's context to
   the host: the system prompt, the history with the donor's message
   classes, and the offered tools. Every other model call (the companion's
   own turns, background lanes) goes to the default transport.
3. A tool call the host makes over MCP inside the turn is answered to the
   donor as the model's tool call. The donor runs the tool with its own
   gates, and the relay returns the tool result from the next call's
   context.
4. `settle` with the host's final reply answers the pending call. The
   donor's loop then ends, and the donor archives the turn and schedules its
   post-turn work, as for any turn. `interrupted` aborts the donor's run.
   `failed` fails the pending call without a retry. A turn the host neither
   continues nor settles within `hostTurnTimeoutMs` is failed
   (`host_turn_timeout`).
5. `checkpoint` reports each named turn as `settled` (in the donor's
   archive) or `open`, so a host can refuse to compact history Lite has not
   recorded.

Both kinds are turns of the same donor session when they use the same
channel. The conformance suite drives the Pi side on the operator's Hermes
channel to prove exactly that. What a host-driven turn cannot reproduce
(re-prompts after the final reply, the donor's turn limits, one agent at a
time, the donor's reply rewriting, provider-side retries) is listed in
[extraction](extraction.md#what-a-host-driven-turn-cannot-reproduce).

## Identity and authority

The transport credential is the only identity. The operator configures
principal bindings (`packages/mcp/src/bindings.ts`): each binding names
where its credential lives (an environment variable or an owner-only file),
the principal, and the contact the principal speaks as. Credentials are kept
as SHA-256 digests and matched in constant time against every binding. No
tool argument or request body names a caller, contact or audience, so a
model cannot change who it is speaking for. The donor then applies its own
trust, audience and disclosure rules to that contact and conversation.

## MCP transport

The MCP transport (`packages/mcp`) is stateless. Every POST is authenticated
on its own and served by a fresh protocol server, so no transport session
can carry authority from one request to the next. It refuses browser
`Origin` headers, `Mcp-Session-Id`, foreign `Host` values (DNS rebinding),
other methods, other paths and oversized bodies. It answers an unknown or
missing credential with a 401 that does not say why. The stdio transport
takes one bound credential at launch and refuses to start without one.

`tools/list` is the donor catalog (see [tool inventory](tool-inventory.md)).
`tools/call` hands the call to the host tool port with the principal. Outside
an open host-driven turn of that principal, the port refuses it
(`no_open_turn`). Failures reach the client as a public error shape that
never carries driver or storage text: `invalid`, `denied`, `not_found`,
`conflict` or `unavailable`. The operator's report gets the detail, never a
credential.

## Lifecycle bridge wire

`POST <lifecycle>/lifecycle/v1/<route>` with `Authorization: Bearer
<credential>`. Bodies are parsed strictly (`wire.ts`):

| Route | Body | Answer |
|---|---|---|
| `prepare` | `hostInstance`, `hermesInstallId`, `idempotencyKey`, `sessionId`, `message` | `{kind: "prepared", turnId, resumed, context}`. `{kind: "replayed"}` when the donor already recorded the key. `{kind: "answered", turnId, reply}` when the donor ended the turn without a model call. |
| `settle` | `hostInstance`, `turnId`, `outcome`: `{kind: "completed", reply}`, `{kind: "interrupted"}` or `{kind: "failed", error: {code, message}}` | `{turnId, status, reply}`: what the donor recorded. A repeated settle gets the same answer. |
| `checkpoint` | `hermesInstallId`, `sessionId`, `turnIds` | `{settled, open}` |
| `memory-deletion/approve` | `hostInstance`, `hermesInstallId`, `proposalId`, `memoryId` | `{proposalId, status: "approved", deleteId}` |
| `automata/claim` | `hostInstance`, `maxIterations` (the host's per-attempt budget), `limit` | `{attempts: [{attemptId, subagentId, name, attempt, maxAttempts, goal, context, budget, credential, leaseMs, busAccess}]}` |
| `automata/heartbeat` | `hostInstance`, `attemptCredential` | `{status: "active" \| "cancel_requested", attempt}` |
| `automata/bus` | `hostInstance`, `attemptCredential`, `arguments` (the child's `automata_bus` call) | `{text, isError}`: core's governed tool result |
| `automata/report` | `hostInstance`, `attemptCredential`, `outcome`: `{kind: "succeeded", summary, model, apiCalls}`, `{kind: "failed" \| "lost", code}` or `{kind: "cancelled"}` | `{attempt, next: "retry" \| "completed" \| "failed" \| "cancelled"}` |

A `prepare`, `checkpoint` or `memory-deletion/approve` for another Hermes
install is refused (403 `wrong_install`).

`memory-deletion/approve` approves a pending deletion proposal that the
donor `memory` tool created inside a host-driven turn. Only a principal
bound to the primary contact may use it, once per proposal, from the owner
of the turn that created it while that turn is open, for the same memory,
and within `hostTurnTimeoutMs`. Otherwise the proposal stays pending
([extraction](extraction.md#e3-memory-deletion-is-approved-through-the-host)).

The `automata/*` routes exist only when the standalone config sets
`lifecycle.automata`, and only a principal bound to the primary contact may
use them. An attempt credential acts only for its attempt and the host
instance that claimed it, and is refused (HTTP 410) once the attempt ends:
reported, lost at its lease, or at the task's attempt cap
([extraction](extraction.md#operator-automata-rules)).

A repeated `prepare` with the key of an open turn answers that turn again
(`resumed: true`). Only the host instance that prepared a turn may settle it
(`not_turn_owner` otherwise). While a turn is open, the donor's one agent is
busy: another principal is told `unavailable` (`capability:
companion_turn`), and the same principal `turn_already_open`.

## Hermes

The host owns credential custody, execution isolation, approvals, provider
access, channel delivery and practical tools. The companion owns its
contacts and audiences, memory disclosure, continuity and authorship. The
Hermes plugin follows that split:

- it switches off Hermes's built-in memory;
- it prepares every root turn of a bound sender, and injects the donor
  context as labelled blocks (`[participant speech]`,
  `[your own earlier reply]`, `[tool result: name]`,
  `[system note: companion context]`);
- its `pre_tool_call` gate blocks Lite's MCP tools outside a Lite turn;
- it sends a companion memory delete to Hermes's human approval gate before
  the call runs, and after an approved call its `post_tool_call` approves
  the proposal in Lite; a denial or a timeout blocks the call and keeps the
  memory;
- it names the Hermes install (the `install_id` file in the Hermes root,
  read and never created) on `prepare` and `checkpoint`;
- it settles every outcome, including the failure paths where Hermes never
  fires `on_session_end`;
- it refuses compaction until `checkpoint` proves the session's turns;
- with hosted automata, it runs the companion's automaton attempts as its
  own subagents through `ctx.subagent_lifecycle`, one child per attempt,
  with the attempt's credential and the Automata Bus as the child's only
  persistence.

Undelivered lifecycle events are kept in a local ledger, retried, and named
in the next turn's context. See the
[plugin README](../integrations/hermes/README.md).

## Excluded

There is no PSFN Gateway, satellite, fleet, shared world, shard, charge
subsystem, wiki, skills, Discord or other channel adapter, CogSec intake
pipeline, Garden, custody store, backup service or card importer. They were
cut from the extracted tree in Steps B1-B7, along with the 17 tool surfaces
whose factories were scaffolding. Step E1 removed those surfaces from the
tool-surface registry too, with the `shard.long_horizon` automata class.
Fatigue regulation is cut for the single companion and deferred, not
dropped ([extraction](extraction.md#e5-fatigue-is-deferred-not-dropped)). The absence test keeps them out of the
manifest, the lockfile, `node_modules`, every import, Lite's own names, and
the deletion record of `packages/companion`.
