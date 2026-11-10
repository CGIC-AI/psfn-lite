# Source provenance

PSFN Lite is derived from https://github.com/CGIC-AI/psfn-framework at
`e6a9546051f4e92bf7218b133b4523ac53a797c0` (the donor). Since extraction
Step C, the companion is the donor's own core, extracted path-preserving into
`packages/companion`. Everything else in the repository is a host adapter
written for Lite around that core, or test support. The extraction record
([extraction](extraction.md)) has the closure, every seam cut, every deleted
or modified test and the equivalence runs. Its machine-readable records are
in `packages/companion/extraction/`.

How to read the entries:

- **extracted unchanged from `<donor path>`**: the same Git blob as the donor
  file at the same path.
- **extracted from `<donor path>`; cut: ...**: the donor file with a
  recorded seam cut (`extraction/cuts.tsv`) or a recorded test deletion or
  edit (`extraction/deleted-tests.tsv`, `extraction/modified-tests.tsv`).
- **Lite**: a file a seam put in place of scaffolding, inside the extracted
  tree. It is not donor code.
- **written for Lite**: a host adapter outside the extracted tree. It is not
  donor code, and it names the donor code it fits.
- **cut**: donor code that is not in Lite, or Lite code that Step C deleted.

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
| `apps/standalone/src/*` | written for Lite: the Lite config document, the substrate config, the CLI and a thin host over donor `startCompanionRuntime` (Lite composition root `packages/companion/src/app/agent/companion-runtime.ts`, seams 3.1, 3.11, B7, C and D). `session-integrity.ts` scopes the donor session keyring to the bound Hermes install (seam E2; donor `createKeyringIntegrityProvider`, `src/persistence/sessions/store-primitives.ts:144`). `model-usage.ts` is the host's in-memory `ModelUsageRecorder` (seam 3.1, E6, in place of the donor's Postgres model-usage store, `src/persistence/postgres/model-usage-store.ts`, cut). `config.ts` names one of the donor embedding provider kinds (`transformers`, `ollama`, `api`; donor `src/faculties/memory/embedding.ts:29`), default the donor seed's `transformers` (seam S5, superseding S1). `substrate-config.ts` sets the donor embedding fields so the core builds the donor provider itself (donor `createEmbeddingProviderFromConfig`, `embedding.ts:721-734`; seam S5), resolves a relative `textEmotionCacheDir` and embedding `cacheDir` under `dataDir` (seams S2, S5) and assembles the config the way donor `src/system/config/load-config.ts` (`loadAgentConfig`, defaults `:76-129`, assembly `:497-565`) and `settings/runtime.ts` (`applyCoreSettings`) did, for the kept subsystems only. |
| `packages/lifecycle/src/*` | written for Lite: host-driven turns. They go through the donor `SubstrateAgent.handleMessage` and the stream transport seam (donor `src/app/agent/core-runtime.ts:724-726`), on the donor's Hermes channel convention (`externalMemorySessionId`). The donor tool catalog is exposed as MCP tools (donor `tool-runtime-facade` `getToolCatalog`). `memory-deletion.ts` is the host `MemoryDeletionApprovalPort` (seam E3), in place of the donor gateway's confirmation surface (donor `src/app/agent/main.ts:583-603`). `host-turns.ts` hands the host the donor's explicit tool contract per model call (seam S3; donor `src/primitives/llm/explicit-tool-request.ts` `resolveExplicitToolContract`, applied as donor `client-request-capability.ts` `applyExplicitToolChoice` and `buildPiContext` did). |
| `packages/mcp/src/*` | written for Lite against `@modelcontextprotocol/server` 2.3.0, the donor's pinned SDK. It follows the donor's external-memory MCP route (`src/channels/api/server/external-memory-mcp.ts`, cut): a stateless per-request handler, a bearer credential bound to a fixed identity, browser `Origin` and `Mcp-Session-Id` refused. Credentials come from the environment or owner-only files and are compared in constant time against every binding (pattern of donor `src/channels/backplane/http/auth.ts` `isExpectedApiToken`, cut). stdio has no donor counterpart. |
| `packages/pi/src/*` | written for Lite against `@earendil-works/pi-ai` 0.84.1, the donor's pinned version. It holds the model runtime the core's provider port takes, and the adapter (`companionEmbeddingProviderOf`) for a host that supplies its own embedding port; the configured embedding providers are the donor's (seam S5). |
| `packages/operator/src/*` | written for Lite: the light Garden's operator surface (seam S8). `garden.ts` composes the donor Garden services of the eight screens as donor `src/operator/garden/local-admin-contract.ts` did (each step cites its donor lines) over the companion's own stores (`CompanionRuntime.garden`). `donor-routes.ts` compiles the donor route builders against the donor route catalogue, and `http.ts` dispatches them as donor `server-routes.ts:59-100` did, with `createStandaloneGardenRequestContext`. `lite-routes.ts` serves what no kept donor route serves: the Overview and Inner life reads, memory delete and restore and the deletion-proposal decisions (decision a), and Settings through the donor owner-file loaders (decision b). `audit.ts` ports donor `appendGardenEntry` to the same `garden-audit-history.jsonl` record. |
| `integrations/hermes/psfn_lite/*` | written for Lite: the Hermes plugin (below). |
| `integrations/hermes/psfn_lite/dashboard/*`, `integrations/hermes/install_plugin.py` | written for Lite: the dashboard backend, a proxy from Hermes's `/api/plugins/psfn_lite/` to the operator surface, and the install tool that never copies the Desktop half (seam S8). |
| `integrations/hermes/desktop/*`, `integrations/hermes/psfn_lite/desktop/plugin.js` | written for Lite against the Hermes Desktop plugin SDK at 2bd378e: the light Garden in Hermes Desktop, and its committed build (seam S8). It reads and writes the donor Garden routes and the Lite routes; it holds no donor code. The donor Garden client (the Svelte app in the donor repository's `admin-ui/`) is not vendored. |
| `tests/*`, `integrations/hermes/tests/*` | written for Lite: tests of the host adapters, the conformance suite and the Hermes plugin tests. `tests/support/postgres-harness.ts` follows donor `src/test-support/postgres-test-harness.ts`: a pinned pgvector image, tmpfs data, a label, a random port, and removal of exactly its own container. |
| `scripts/bench/footprint.ts` | written for Lite: the install-footprint measurement ([footprint](footprint.md)). |
| `Dockerfile`, `compose.yaml`, `docker/*` | written for Lite: the standalone host and its PostgreSQL as a Compose project ([docker](docker.md)). The pgvector image is the one `tests/support/postgres-harness.ts` pins. |

## The extracted core (`packages/companion`)

The tables below are generated from the Git blobs of
`packages/companion/{src,config}` at `HEAD` and the donor commit by
`python3 -I packages/companion/extraction/provenance-tables.py <donor git
dir>`, after Step E; the 2026-11-09 shakedown fixes (seams S1-S4, S6
for round r2 and S7 for round r3) and the restored donor embedding providers (seam S5)
changed no file here. Seam S8 (the light Garden, [extraction](extraction.md),
"S8: the light Garden") re-vendored the donor Garden services and routes and
added the `CompanionRuntime.garden` host seam. The tree now has 2,100 files: 1,839 extracted unchanged, 227 extracted with cuts, and 34 Lite. Seam D is the operator
automata rules ([extraction](extraction.md), "Operator automata rules").
Seams E1-E4 are the operator rulings of 2026-11-08/09 that changed files
([extraction](extraction.md), "Step E"). The extraction records, package
files and `baseline.json` are Lite's own and are not listed.

### Extracted unchanged

Every file counted here is byte-identical (the same Git blob) to the donor file at the same path. Where a directory also holds changed or Lite-new files, they are in the next two tables.

| Lite path (under `packages/companion/`) | Entry |
|---|---|
| `config/` | extracted unchanged from donor `config/` (7 files; 2 changed listed below) |
| `src/app/agent/` | extracted unchanged from donor `src/app/agent/` (16 files; 7 changed, 2 Lite-new listed below) |
| `src/app/agent/startup/` | extracted unchanged from donor `src/app/agent/startup/` (9 files; 2 changed listed below) |
| `src/app/startup/composition/` | extracted unchanged from donor `src/app/startup/composition/` (4 files; 5 changed listed below) |
| `src/app/startup/support/` | extracted unchanged from donor `src/app/startup/support/` (4 files; 3 changed listed below) |
| `src/boundary/fleet-auth/` | extracted unchanged from donor `src/boundary/fleet-auth/` (2 files; 4 changed listed below) |
| `src/boundary/integrations/journal/` | extracted unchanged from donor `src/boundary/integrations/journal/` (12 files) |
| `src/boundary/integrations/` | extracted unchanged from donor `src/boundary/integrations/` (1 file) |
| `src/boundary/pi-agent/` | extracted unchanged from donor `src/boundary/pi-agent/` (3 files) |
| `src/channels/backplane/http/` | extracted unchanged from donor `src/channels/backplane/http/` (2 files) |
| `src/core/agent/` | extracted unchanged from donor `src/core/agent/` (57 files; 11 changed listed below) |
| `src/core/agent/background-work/` | extracted unchanged from donor `src/core/agent/background-work/` (18 files) |
| `src/core/agent/substrate-agent/` | extracted unchanged from donor `src/core/agent/substrate-agent/` (42 files; 25 changed, 1 Lite-new listed below) |
| `src/core/agent/substrate-agent/runtime-context-sections/` | extracted unchanged from donor `src/core/agent/substrate-agent/runtime-context-sections/` (20 files; 3 changed listed below) |
| `src/core/agent/substrate-agent/turn-execution/` | extracted unchanged from donor `src/core/agent/substrate-agent/turn-execution/` (19 files; 4 changed listed below) |
| `src/core/agent/tool-surface/` | extracted unchanged from donor `src/core/agent/tool-surface/` (5 files; 7 changed listed below) |
| `src/core/agent/tool-surface/descriptions/` | extracted unchanged from donor `src/core/agent/tool-surface/descriptions/` (2 files; 3 changed listed below) |
| `src/core/artifacts/` | extracted unchanged from donor `src/core/artifacts/` (1 file; 2 changed listed below) |
| `src/core/cogsec/` | extracted unchanged from donor `src/core/cogsec/` (4 files; 2 changed listed below) |
| `src/core/cogsec/disclosure/` | extracted unchanged from donor `src/core/cogsec/disclosure/` (9 files) |
| `src/core/cogsec/intake/` | extracted unchanged from donor `src/core/cogsec/intake/` (2 files; 1 changed listed below) |
| `src/core/contacts/` | extracted unchanged from donor `src/core/contacts/` (36 files; 3 changed listed below) |
| `src/core/contacts/postgres-adapter/` | extracted unchanged from donor `src/core/contacts/postgres-adapter/` (24 files; 2 changed listed below) |
| `src/core/contacts/store/` | extracted unchanged from donor `src/core/contacts/store/` (3 files) |
| `src/core/doing-mirror/` | extracted unchanged from donor `src/core/doing-mirror/` (3 files; 2 changed listed below) |
| `src/core/emotion/` | extracted unchanged from donor `src/core/emotion/` (38 files) |
| `src/core/emotion/partner-affect/` | extracted unchanged from donor `src/core/emotion/partner-affect/` (7 files) |
| `src/core/eval/observer-sidecar/` | extracted unchanged from donor `src/core/eval/observer-sidecar/` (32 files) |
| `src/core/icp/` | extracted unchanged from donor `src/core/icp/` (30 files; 5 changed listed below) |
| `src/core/identity/` | extracted unchanged from donor `src/core/identity/` (46 files; 3 changed listed below) |
| `src/core/identity/prompt-runtime/` | extracted unchanged from donor `src/core/identity/prompt-runtime/` (1 file) |
| `src/core/intention/` | extracted unchanged from donor `src/core/intention/` (82 files; 1 changed listed below) |
| `src/core/intention/appraisal/` | extracted unchanged from donor `src/core/intention/appraisal/` (16 files) |
| `src/core/intention/postgres-adapters/` | extracted unchanged from donor `src/core/intention/postgres-adapters/` (13 files) |
| `src/core/intention/social-outreach-turn/` | extracted unchanged from donor `src/core/intention/social-outreach-turn/` (5 files) |
| `src/core/internal-role-envelopes/` | extracted unchanged from donor `src/core/internal-role-envelopes/` (9 files) |
| `src/core/letters/` | extracted unchanged from donor `src/core/letters/` (4 files; 1 changed listed below) |
| `src/core/scheduler/` | extracted unchanged from donor `src/core/scheduler/` (60 files; 13 changed, 2 Lite-new listed below) |
| `src/core/scheduler/reflection-template-runtime/` | extracted unchanged from donor `src/core/scheduler/reflection-template-runtime/` (11 files; 1 changed listed below) |
| `src/core/self-model/` | extracted unchanged from donor `src/core/self-model/` (8 files) |
| `src/core/session/` | extracted unchanged from donor `src/core/session/` (72 files; 9 changed listed below) |
| `src/core/session/group-chat-harness/` | extracted unchanged from donor `src/core/session/group-chat-harness/` (5 files) |
| `src/core/session/group-chat-harness/goldens/` | extracted unchanged from donor `src/core/session/group-chat-harness/goldens/` (7 files) |
| `src/core/session/manager/` | extracted unchanged from donor `src/core/session/manager/` (22 files; 4 changed listed below) |
| `src/core/tools/` | extracted unchanged from donor `src/core/tools/` (10 files) |
| `src/core/turns/` | extracted unchanged from donor `src/core/turns/` (9 files) |
| `src/faculties/automata/` | extracted unchanged from donor `src/faculties/automata/` (19 files; 5 changed listed below) |
| `src/faculties/automata/bus/` | extracted unchanged from donor `src/faculties/automata/bus/` (41 files; 12 changed, 2 Lite-new listed below) |
| `src/faculties/automata/bus/conformance/v1/accept/` | extracted unchanged from donor `src/faculties/automata/bus/conformance/v1/accept/` (2 files) |
| `src/faculties/automata/bus/conformance/v1/` | extracted unchanged from donor `src/faculties/automata/bus/conformance/v1/` (1 file) |
| `src/faculties/automata/bus/conformance/v1/not-understood/` | extracted unchanged from donor `src/faculties/automata/bus/conformance/v1/not-understood/` (2 files) |
| `src/faculties/automata/bus/conformance/v1/reject/` | extracted unchanged from donor `src/faculties/automata/bus/conformance/v1/reject/` (5 files) |
| `src/faculties/automata/bus/conformance/v1/state/` | extracted unchanged from donor `src/faculties/automata/bus/conformance/v1/state/` (2 files) |
| `src/faculties/core-memory/` | extracted unchanged from donor `src/faculties/core-memory/` (6 files; 1 changed listed below) |
| `src/faculties/introspection/` | extracted unchanged from donor `src/faculties/introspection/` (17 files; 1 changed listed below) |
| `src/faculties/memory/` | extracted unchanged from donor `src/faculties/memory/` (63 files; 9 changed, 1 Lite-new listed below) |
| `src/faculties/memory/biographical/` | extracted unchanged from donor `src/faculties/memory/biographical/` (51 files; 2 changed listed below) |
| `src/faculties/memory/episodic/` | extracted unchanged from donor `src/faculties/memory/episodic/` (29 files) |
| `src/faculties/memory/episodic/postgres-store/` | extracted unchanged from donor `src/faculties/memory/episodic/postgres-store/` (4 files) |
| `src/faculties/memory/episodic/synthesis/` | extracted unchanged from donor `src/faculties/memory/episodic/synthesis/` (4 files) |
| `src/faculties/memory/external/` | extracted unchanged from donor `src/faculties/memory/external/` (1 file; 2 changed listed below) |
| `src/faculties/memory/extraction/` | extracted unchanged from donor `src/faculties/memory/extraction/` (82 files; 3 changed listed below) |
| `src/faculties/memory/postgres-store/` | extracted unchanged from donor `src/faculties/memory/postgres-store/` (35 files) |
| `src/faculties/memory/retrieval/` | extracted unchanged from donor `src/faculties/memory/retrieval/` (43 files) |
| `src/faculties/memory/social-graph/` | extracted unchanged from donor `src/faculties/memory/social-graph/` (4 files) |
| `src/faculties/memory/tools/` | extracted unchanged from donor `src/faculties/memory/tools/` (3 files) |
| `src/faculties/memory/writer/` | extracted unchanged from donor `src/faculties/memory/writer/` (2 files) |
| `src/faculties/north-star/` | extracted unchanged from donor `src/faculties/north-star/` (4 files) |
| `src/faculties/shards/` | extracted unchanged from donor `src/faculties/shards/` (9 files; 2 changed, 1 Lite-new listed below) |
| `src/faculties/subagents/` | extracted unchanged from donor `src/faculties/subagents/` (18 files; 2 changed, 2 Lite-new listed below) |
| `src/faculties/values/` | extracted unchanged from donor `src/faculties/values/` (7 files) |
| `src/operator/garden/` | extracted unchanged from donor `src/operator/garden/` (14 files; 5 changed, 2 Lite-new listed below) |
| `src/operator/garden/routes/` | extracted unchanged from donor `src/operator/garden/routes/` (8 files; 8 changed listed below) |
| `src/operator/garden/services/` | extracted unchanged from donor `src/operator/garden/services/` (35 files; 8 changed listed below) |
| `src/operator/garden/services/types/` | extracted unchanged from donor `src/operator/garden/services/types/` (6 files; 2 changed listed below) |
| `src/persistence/journals/` | extracted unchanged from donor `src/persistence/journals/` (10 files; 2 changed listed below) |
| `src/persistence/journals/journal/` | extracted unchanged from donor `src/persistence/journals/journal/` (10 files) |
| `src/persistence/` | extracted unchanged from donor `src/persistence/` (10 files; 3 changed listed below) |
| `src/persistence/postgres/` | extracted unchanged from donor `src/persistence/postgres/` (62 files; 6 changed listed below) |
| `src/persistence/reflections/` | extracted unchanged from donor `src/persistence/reflections/` (2 files) |
| `src/persistence/repair/` | extracted unchanged from donor `src/persistence/repair/` (4 files) |
| `src/persistence/sessions/` | extracted unchanged from donor `src/persistence/sessions/` (43 files; 4 changed listed below) |
| `src/persistence/sessions/store/` | extracted unchanged from donor `src/persistence/sessions/store/` (23 files) |
| `src/primitives/images/` | extracted unchanged from donor `src/primitives/images/` (4 files) |
| `src/primitives/llm/` | extracted unchanged from donor `src/primitives/llm/` (58 files; 3 changed listed below) |
| `src/primitives/llm/decision/` | extracted unchanged from donor `src/primitives/llm/decision/` (10 files) |
| `src/shared/` | extracted unchanged from donor `src/shared/` (19 files; 1 changed listed below) |
| `src/shared/cache/` | extracted unchanged from donor `src/shared/cache/` (3 files) |
| `src/shared/contracts/` | extracted unchanged from donor `src/shared/contracts/` (76 files; 2 changed, 15 Lite-new listed below) |
| `src/shared/diagnostics/` | extracted unchanged from donor `src/shared/diagnostics/` (7 files) |
| `src/shared/escalation/` | extracted unchanged from donor `src/shared/escalation/` (2 files) |
| `src/shared/gating/` | extracted unchanged from donor `src/shared/gating/` (2 files) |
| `src/shared/observability/health-detectors/` | extracted unchanged from donor `src/shared/observability/health-detectors/` (4 files) |
| `src/shared/observability/` | extracted unchanged from donor `src/shared/observability/` (2 files) |
| `src/shared/resilience/` | extracted unchanged from donor `src/shared/resilience/` (2 files) |
| `src/shared/routing/` | extracted unchanged from donor `src/shared/routing/` (5 files) |
| `src/shared/telemetry/` | extracted unchanged from donor `src/shared/telemetry/` (16 files; 1 Lite-new listed below) |
| `src/shared/time/` | extracted unchanged from donor `src/shared/time/` (4 files) |
| `src/shared/tools/` | extracted unchanged from donor `src/shared/tools/` (2 files) |
| `src/shared/utils/` | extracted unchanged from donor `src/shared/utils/` (29 files) |
| `src/system/capabilities/` | extracted unchanged from donor `src/system/capabilities/` (16 files; 2 changed, 1 Lite-new listed below) |
| `src/system/config/` | extracted unchanged from donor `src/system/config/` (40 files; 11 changed, 2 Lite-new listed below) |
| `src/system/config/fixtures/` | extracted unchanged from donor `src/system/config/fixtures/` (2 files; 1 changed listed below) |
| `src/system/config/scheduler-config/` | extracted unchanged from donor `src/system/config/scheduler-config/` (21 files) |
| `src/system/lifecycle/` | extracted unchanged from donor `src/system/lifecycle/` (6 files) |
| `src/system/security/` | extracted unchanged from donor `src/system/security/` (2 files) |
| `src/system/trust/` | extracted unchanged from donor `src/system/trust/` (15 files) |
| `src/test-support/` | extracted unchanged from donor `src/test-support/` (18 files; 2 changed, 2 Lite-new listed below) |
| `src/test-support/fixtures/` | extracted unchanged from donor `src/test-support/fixtures/` (1 file) |

### Extracted with cuts

| Lite path (under `packages/companion/`) | Entry |
|---|---|
| `config/automata-policy.seed.json` | extracted from donor `config/automata-policy.seed.json`; cut: seam E1 (`extraction/cuts.tsv`) |
| `config/capability-tier.seed.json` | extracted from donor `config/capability-tier.seed.json`; cut: seam E4 (`extraction/cuts.tsv`) |
| `src/app/agent/automata-background-work-lifecycle.test.ts` | extracted from donor `src/app/agent/automata-background-work-lifecycle.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/app/agent/decision/decision-runtime.ts` | extracted from donor `src/app/agent/decision/decision-runtime.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/agent/icp-initiation-source-wiring.ts` | extracted from donor `src/app/agent/icp-initiation-source-wiring.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/agent/intention-follow-up-destination.ts` | extracted from donor `src/app/agent/intention-follow-up-destination.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/agent/scheduler-runtime.test.ts` | extracted from donor `src/app/agent/scheduler-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/agent/scheduler-runtime.ts` | extracted from donor `src/app/agent/scheduler-runtime.ts`; cut: seam 3.11, 3.18 (`extraction/cuts.tsv`) |
| `src/app/agent/startup-continuity.test.ts` | extracted from donor `src/app/agent/startup-continuity.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/agent/startup-continuity.ts` | extracted from donor `src/app/agent/startup-continuity.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/agent/startup/free-time-lane.test.ts` | extracted from donor `src/app/agent/startup/free-time-lane.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/app/agent/startup/free-time-lane.ts` | extracted from donor `src/app/agent/startup/free-time-lane.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/startup/composition/composition.test.ts` | extracted from donor `src/app/startup/composition/composition.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/startup/composition/composition.ts` | extracted from donor `src/app/startup/composition/composition.ts`; cut: seam 3.6, 3.11, D (`extraction/cuts.tsv`) |
| `src/app/startup/composition/parity.test.ts` | extracted from donor `src/app/startup/composition/parity.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/startup/composition/parity.ts` | extracted from donor `src/app/startup/composition/parity.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/startup/composition/post-turn-actions.test.ts` | extracted from donor `src/app/startup/composition/post-turn-actions.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/startup/support/ml-warmup.ts` | extracted from donor `src/app/startup/support/ml-warmup.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/app/startup/support/operator-alerts.test.ts` | extracted from donor `src/app/startup/support/operator-alerts.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/app/startup/support/operator-alerts.ts` | extracted from donor `src/app/startup/support/operator-alerts.ts`; cut: seam 3.11, E1 (`extraction/cuts.tsv`) |
| `src/boundary/fleet-auth/garden-route-authorization.ts` | extracted from donor `src/boundary/fleet-auth/garden-route-authorization.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/boundary/fleet-auth/garden-route-capabilities.test.ts` | extracted from donor `src/boundary/fleet-auth/garden-route-capabilities.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/boundary/fleet-auth/role-action-policy.test.ts` | extracted from donor `src/boundary/fleet-auth/role-action-policy.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/boundary/fleet-auth/role-action-policy.ts` | extracted from donor `src/boundary/fleet-auth/role-action-policy.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/boundary/integrations/filesystem/text-file-paging.ts` | extracted from donor `src/boundary/integrations/filesystem/text-file-paging.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/core/agent/companion-availability.test.ts` | extracted from donor `src/core/agent/companion-availability.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/completion-handoff.ts` | extracted from donor `src/core/agent/completion-handoff.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/agent/contracts.ts` | extracted from donor `src/core/agent/contracts.ts`; cut: seam 3.2, 3.6, 3.13, 3.17, E1 (`extraction/cuts.tsv`) |
| `src/core/agent/satellite-adapter-port.ts` | extracted from donor `src/core/agent/satellite-adapter-port.ts`; cut: seam 3.12 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent.test.ts` | extracted from donor `src/core/agent/substrate-agent.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent.ts` | extracted from donor `src/core/agent/substrate-agent.ts`; cut: seam 3.2, 3.3, 3.4, 3.6, 3.12, 3.13, 3.17, 3.18 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/adaptive-tools-runtime.test.ts` | extracted from donor `src/core/agent/substrate-agent/adaptive-tools-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/adaptive-tools-runtime.ts` | extracted from donor `src/core/agent/substrate-agent/adaptive-tools-runtime.ts`; cut: seam 3.18 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/channel-routing-runtime.test.ts` | extracted from donor `src/core/agent/substrate-agent/channel-routing-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/channel-routing-runtime.ts` | extracted from donor `src/core/agent/substrate-agent/channel-routing-runtime.ts`; cut: seam 3.12 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/egress-tool-custody.test.ts` | extracted from donor `src/core/agent/substrate-agent/egress-tool-custody.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/egress-tool-guard.ts` | extracted from donor `src/core/agent/substrate-agent/egress-tool-guard.ts`; cut: seam 3.4, 3.6 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/moa-turn.test.ts` | extracted from donor `src/core/agent/substrate-agent/moa-turn.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/moa-turn.ts` | extracted from donor `src/core/agent/substrate-agent/moa-turn.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/perception-cue.test.ts` | extracted from donor `src/core/agent/substrate-agent/perception-cue.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/perception-cue.ts` | extracted from donor `src/core/agent/substrate-agent/perception-cue.ts`; cut: seam 3.13 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/prompt-context-builder.ts` | extracted from donor `src/core/agent/substrate-agent/prompt-context-builder.ts`; cut: seam 3.12, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/runtime-context-sections/reaction-surface.test.ts` | extracted from donor `src/core/agent/substrate-agent/runtime-context-sections/reaction-surface.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/runtime-context-sections/reaction-surface.ts` | extracted from donor `src/core/agent/substrate-agent/runtime-context-sections/reaction-surface.ts`; cut: seam 3.12 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/runtime-context-sections/situated-presence.test.ts` | extracted from donor `src/core/agent/substrate-agent/runtime-context-sections/situated-presence.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/runtime-context.test.ts` | extracted from donor `src/core/agent/substrate-agent/runtime-context.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/runtime-context.ts` | extracted from donor `src/core/agent/substrate-agent/runtime-context.ts`; cut: seam 3.12 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/tool-runtime-facade.test.ts` | extracted from donor `src/core/agent/substrate-agent/tool-runtime-facade.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/tool-runtime-facade.ts` | extracted from donor `src/core/agent/substrate-agent/tool-runtime-facade.ts`; cut: seam 3.18 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution-adapter.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution-adapter.ts`; cut: seam 3.2, 3.6, 3.13, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution-runtime.test.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/turn-execution-runtime.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution-runtime.ts`; cut: seam 3.6, 3.13, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution/contracts.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution/contracts.ts`; cut: seam 3.2, 3.6, 3.13, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution/post-turn-scheduling.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution/post-turn-scheduling.ts`; cut: seam 3.12, 3.13 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts` | extracted from donor `src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts`; cut: seam 3.6, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-record-slimming.test.ts` | extracted from donor `src/core/agent/substrate-agent/turn-record-slimming.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/turn-records.test.ts` | extracted from donor `src/core/agent/substrate-agent/turn-records.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/turn-records.ts` | extracted from donor `src/core/agent/substrate-agent/turn-records.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/turn-support-runtime.test.ts` | extracted from donor `src/core/agent/substrate-agent/turn-support-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/substrate-agent/turn-support-runtime.ts` | extracted from donor `src/core/agent/substrate-agent/turn-support-runtime.ts`; cut: seam 3.6, 3.17 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/vision-attachments.test.ts` | extracted from donor `src/core/agent/substrate-agent/vision-attachments.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/substrate-agent/vision-attachments.ts` | extracted from donor `src/core/agent/substrate-agent/vision-attachments.ts`; cut: seam 3.13 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-call-correction.test.ts` | extracted from donor `src/core/agent/tool-call-correction.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/tool-call-scheduler.test.ts` | extracted from donor `src/core/agent/tool-call-scheduler.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/tool-call-scheduler.ts` | extracted from donor `src/core/agent/tool-call-scheduler.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-outcome-claim-guard.test.ts` | extracted from donor `src/core/agent/tool-outcome-claim-guard.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/tool-surface/canonical-tool-catalog.test-support.ts` | extracted from donor `src/core/agent/tool-surface/canonical-tool-catalog.test-support.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/agent/tool-surface/descriptions.ts` | extracted from donor `src/core/agent/tool-surface/descriptions.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-surface/descriptions/agency-contracts.ts` | extracted from donor `src/core/agent/tool-surface/descriptions/agency-contracts.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-surface/descriptions/catalog-boundary-contracts.ts` | extracted from donor `src/core/agent/tool-surface/descriptions/catalog-boundary-contracts.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-surface/descriptions/operations-contracts.ts` | extracted from donor `src/core/agent/tool-surface/descriptions/operations-contracts.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-surface/hydration.test.ts` | extracted from donor `src/core/agent/tool-surface/hydration.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/tool-surface/registry.test.ts` | extracted from donor `src/core/agent/tool-surface/registry.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/tool-surface/registry.ts` | extracted from donor `src/core/agent/tool-surface/registry.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/tool-surface/viewer-gates.test.ts` | extracted from donor `src/core/agent/tool-surface/viewer-gates.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/agent/tool-surface/viewer-gates.ts` | extracted from donor `src/core/agent/tool-surface/viewer-gates.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/agent/worker-lanes.ts` | extracted from donor `src/core/agent/worker-lanes.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/core/artifacts/sensitivity-egress-custody.test.ts` | extracted from donor `src/core/artifacts/sensitivity-egress-custody.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/artifacts/sensitivity-egress.ts` | extracted from donor `src/core/artifacts/sensitivity-egress.ts`; cut: seam 3.2, 3.6 (`extraction/cuts.tsv`) |
| `src/core/cogsec/intake/derived-content.ts` | extracted from donor `src/core/cogsec/intake/derived-content.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/cogsec/memory-candidacy.test.ts` | extracted from donor `src/core/cogsec/memory-candidacy.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/cogsec/memory-candidacy.ts` | extracted from donor `src/core/cogsec/memory-candidacy.ts`; cut: seam 3.4, 3.5 (`extraction/cuts.tsv`) |
| `src/core/contacts/contact-tracking-approval-flow.test.ts` | extracted from donor `src/core/contacts/contact-tracking-approval-flow.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/contacts/observed-machine-intelligence.test.ts` | extracted from donor `src/core/contacts/observed-machine-intelligence.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/contacts/postgres-adapter.integration.test.ts` | extracted from donor `src/core/contacts/postgres-adapter.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/contacts/postgres-adapter/contact-archive.integration.test.ts` | extracted from donor `src/core/contacts/postgres-adapter/contact-archive.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/contacts/postgres-adapter/contact-lifecycle-ledger.integration.test.ts` | extracted from donor `src/core/contacts/postgres-adapter/contact-lifecycle-ledger.integration.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/doing-mirror/sources.test.ts` | extracted from donor `src/core/doing-mirror/sources.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/doing-mirror/sources.ts` | extracted from donor `src/core/doing-mirror/sources.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/core/icp/agent-facing-autonomy.ts` | extracted from donor `src/core/icp/agent-facing-autonomy.ts`; cut: seam 3.15 (`extraction/cuts.tsv`) |
| `src/core/icp/initiation-source-support.ts` | extracted from donor `src/core/icp/initiation-source-support.ts`; cut: seam 3.15 (`extraction/cuts.tsv`) |
| `src/core/icp/runtime-availability.ts` | extracted from donor `src/core/icp/runtime-availability.ts`; cut: seam 3.15 (`extraction/cuts.tsv`) |
| `src/core/icp/speaking-precedence-resolver.test.ts` | extracted from donor `src/core/icp/speaking-precedence-resolver.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/icp/speaking-precedence-resolver.ts` | extracted from donor `src/core/icp/speaking-precedence-resolver.ts`; cut: seam 3.15 (`extraction/cuts.tsv`) |
| `src/core/identity/persona-preamble-seeds.ts` | extracted from donor `src/core/identity/persona-preamble-seeds.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/identity/prompt-registry.test.ts` | extracted from donor `src/core/identity/prompt-registry.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/identity/prompt-registry.ts` | extracted from donor `src/core/identity/prompt-registry.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/core/intention/concern-resolution-arc.test.ts` | extracted from donor `src/core/intention/concern-resolution-arc.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/letters/memory-extraction.test.ts` | extracted from donor `src/core/letters/memory-extraction.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/scheduler/free-time-workspace-resolver.ts` | extracted from donor `src/core/scheduler/free-time-workspace-resolver.ts`; cut: seam 3.6, 3.17 (`extraction/cuts.tsv`) |
| `src/core/scheduler/free-time.test.ts` | extracted from donor `src/core/scheduler/free-time.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/scheduler/free-time.ts` | extracted from donor `src/core/scheduler/free-time.ts`; cut: seam 3.6, 3.9 (`extraction/cuts.tsv`) |
| `src/core/scheduler/health-detector-task.test.ts` | extracted from donor `src/core/scheduler/health-detector-task.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/scheduler/post-turn-lanes.test.ts` | extracted from donor `src/core/scheduler/post-turn-lanes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/scheduler/post-turn-runtime.ts` | extracted from donor `src/core/scheduler/post-turn-runtime.ts`; cut: seam 3.6 (`extraction/cuts.tsv`) |
| `src/core/scheduler/post-turn-runtime/scheduler-lanes.ts` | extracted from donor `src/core/scheduler/post-turn-runtime/scheduler-lanes.ts`; cut: seam 3.6, 3.9 (`extraction/cuts.tsv`) |
| `src/core/scheduler/quiet-hours-release-stagger.ts` | extracted from donor `src/core/scheduler/quiet-hours-release-stagger.ts`; cut: seam 3.9 (`extraction/cuts.tsv`) |
| `src/core/scheduler/reflection-runtime-contracts.ts` | extracted from donor `src/core/scheduler/reflection-runtime-contracts.ts`; cut: seam 3.6, 3.9, 3.17 (`extraction/cuts.tsv`) |
| `src/core/scheduler/reflection-template-runtime/daily-review-evidence.test.ts` | extracted from donor `src/core/scheduler/reflection-template-runtime/daily-review-evidence.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/scheduler/return-note-projection.test.ts` | extracted from donor `src/core/scheduler/return-note-projection.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/scheduler/return-note-projection.ts` | extracted from donor `src/core/scheduler/return-note-projection.ts`; cut: seam 3.6 (`extraction/cuts.tsv`) |
| `src/core/scheduler/return-note-routing.test.ts` | extracted from donor `src/core/scheduler/return-note-routing.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/core/scheduler/return-note-routing.ts` | extracted from donor `src/core/scheduler/return-note-routing.ts`; cut: seam 3.6 (`extraction/cuts.tsv`) |
| `src/core/scheduler/scheduler.ts` | extracted from donor `src/core/scheduler/scheduler.ts`; cut: seam 3.4, 3.9 (`extraction/cuts.tsv`) |
| `src/core/session/icp-delivery-recovery.test.ts` | extracted from donor `src/core/session/icp-delivery-recovery.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/icp-recovery-response-metadata.ts` | extracted from donor `src/core/session/icp-recovery-response-metadata.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/core/session/intake-screening-metadata.ts` | extracted from donor `src/core/session/intake-screening-metadata.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/session/intake-sink-gating.test.ts` | extracted from donor `src/core/session/intake-sink-gating.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/intake-sink-gating.ts` | extracted from donor `src/core/session/intake-sink-gating.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/session/manager-intake-screening.test.ts` | extracted from donor `src/core/session/manager-intake-screening.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/manager-primitives.ts` | extracted from donor `src/core/session/manager-primitives.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/session/manager.test.ts` | extracted from donor `src/core/session/manager.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/manager.ts` | extracted from donor `src/core/session/manager.ts`; cut: seam 3.4, 3.12 (`extraction/cuts.tsv`) |
| `src/core/session/manager/context-builder.channel-bond.test.ts` | extracted from donor `src/core/session/manager/context-builder.channel-bond.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/manager/context-builder.test.ts` | extracted from donor `src/core/session/manager/context-builder.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/core/session/manager/context-builder.ts` | extracted from donor `src/core/session/manager/context-builder.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/core/session/manager/icp-delivery-projection-store.test.ts` | extracted from donor `src/core/session/manager/icp-delivery-projection-store.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/automata-certification.test.ts` | extracted from donor `src/faculties/automata/automata-certification.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/bus/class-adapters.ts` | extracted from donor `src/faculties/automata/bus/class-adapters.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/faculties/automata/bus/class-lifecycle.test.ts` | extracted from donor `src/faculties/automata/bus/class-lifecycle.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/bus/postgres-store.integration.test.ts` | extracted from donor `src/faculties/automata/bus/postgres-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/automata/bus/production-runtime.test.ts` | extracted from donor `src/faculties/automata/bus/production-runtime.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/bus/production-worker-adapter.test.ts` | extracted from donor `src/faculties/automata/bus/production-worker-adapter.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/bus/production-worker-adapter.ts` | extracted from donor `src/faculties/automata/bus/production-worker-adapter.ts`; cut: seam D (`extraction/cuts.tsv`) |
| `src/faculties/automata/bus/worker-access-contracts.ts` | extracted from donor `src/faculties/automata/bus/worker-access-contracts.ts`; cut: seam D (`extraction/cuts.tsv`) |
| `src/faculties/automata/bus/worker-access-operation.ts` | extracted from donor `src/faculties/automata/bus/worker-access-operation.ts`; cut: seam D (`extraction/cuts.tsv`) |
| `src/faculties/automata/bus/worker-access-tool.ts` | extracted from donor `src/faculties/automata/bus/worker-access-tool.ts`; cut: seam D (`extraction/cuts.tsv`) |
| `src/faculties/automata/bus/worker-execution-restart.integration.test.ts` | extracted from donor `src/faculties/automata/bus/worker-execution-restart.integration.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/automata/bus/worker-execution.test.ts` | extracted from donor `src/faculties/automata/bus/worker-execution.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/automata/bus/worker-run-notes.test.ts` | extracted from donor `src/faculties/automata/bus/worker-run-notes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/automata/production-registration.ts` | extracted from donor `src/faculties/automata/production-registration.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/faculties/automata/registry-contract.ts` | extracted from donor `src/faculties/automata/registry-contract.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/faculties/automata/retention-coordinator.test.ts` | extracted from donor `src/faculties/automata/retention-coordinator.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/automata/retention-coordinator.ts` | extracted from donor `src/faculties/automata/retention-coordinator.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/faculties/core-memory/tools.test.ts` | extracted from donor `src/faculties/core-memory/tools.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/introspection/postgres-store.integration.test.ts` | extracted from donor `src/faculties/introspection/postgres-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/memory/biographical/cross-channel-conformance.integration.test.ts` | extracted from donor `src/faculties/memory/biographical/cross-channel-conformance.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/biographical/postgres-store.integration.test.ts` | extracted from donor `src/faculties/memory/biographical/postgres-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/embedding.test.ts` | extracted from donor `src/faculties/memory/embedding.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/memory/embedding.ts` | extracted from donor `src/faculties/memory/embedding.ts`; cut: seam 3.14 (`extraction/cuts.tsv`) |
| `src/faculties/memory/external/service.test.ts` | extracted from donor `src/faculties/memory/external/service.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/memory/external/service.ts` | extracted from donor `src/faculties/memory/external/service.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/faculties/memory/extraction/fact-acceptance.test.ts` | extracted from donor `src/faculties/memory/extraction/fact-acceptance.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/memory/extraction/fact-acceptance.ts` | extracted from donor `src/faculties/memory/extraction/fact-acceptance.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/faculties/memory/extraction/orchestrator.test.ts` | extracted from donor `src/faculties/memory/extraction/orchestrator.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/postgres-store.integration.test.ts` | extracted from donor `src/faculties/memory/postgres-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/retrieval-cache.test.ts` | extracted from donor `src/faculties/memory/retrieval-cache.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/runtime-wiring.ts` | extracted from donor `src/faculties/memory/runtime-wiring.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/faculties/memory/sleeptime-agent.test.ts` | extracted from donor `src/faculties/memory/sleeptime-agent.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/sleeptime-agent.ts` | extracted from donor `src/faculties/memory/sleeptime-agent.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/faculties/memory/writer.test.ts` | extracted from donor `src/faculties/memory/writer.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/faculties/memory/writer.ts` | extracted from donor `src/faculties/memory/writer.ts`; cut: seam 3.4 (`extraction/cuts.tsv`) |
| `src/faculties/shards/fold-review.ts` | extracted from donor `src/faculties/shards/fold-review.ts`; cut: seam 3.4, 3.17 (`extraction/cuts.tsv`) |
| `src/faculties/shards/output-review.ts` | extracted from donor `src/faculties/shards/output-review.ts`; cut: seam 3.17 (`extraction/cuts.tsv`) |
| `src/faculties/subagents/faculty.test.ts` | extracted from donor `src/faculties/subagents/faculty.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/faculties/subagents/faculty.ts` | extracted from donor `src/faculties/subagents/faculty.ts`; cut: seam D (`extraction/cuts.tsv`) |
| `src/operator/garden/api-routes-memory.test.ts` | extracted from donor `src/operator/garden/api-routes-memory.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/api-routes-memory.ts` | extracted from donor `src/operator/garden/api-routes-memory.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/garden-companion-scope.test.ts` | extracted from donor `src/operator/garden/garden-companion-scope.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/garden-request-context.test.ts` | extracted from donor `src/operator/garden/garden-request-context.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/garden-request-context.ts` | extracted from donor `src/operator/garden/garden-request-context.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/routes/automata-routes.test.ts` | extracted from donor `src/operator/garden/routes/automata-routes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/operator/garden/routes/concern-routes.ts` | extracted from donor `src/operator/garden/routes/concern-routes.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/routes/identity-routes.ts` | extracted from donor `src/operator/garden/routes/identity-routes.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/routes/scheduler-routes.test.ts` | extracted from donor `src/operator/garden/routes/scheduler-routes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/operator/garden/routes/scheduler-routes.ts` | extracted from donor `src/operator/garden/routes/scheduler-routes.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/routes/session-routes.test.ts` | extracted from donor `src/operator/garden/routes/session-routes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/routes/session-routes.ts` | extracted from donor `src/operator/garden/routes/session-routes.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/routes/types.ts` | extracted from donor `src/operator/garden/routes/types.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/automata-coverage.test.ts` | extracted from donor `src/operator/garden/services/automata-coverage.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/operator/garden/services/automata-service.test.ts` | extracted from donor `src/operator/garden/services/automata-service.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/operator/garden/services/identity-service.test.ts` | extracted from donor `src/operator/garden/services/identity-service.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/services/identity-service.ts` | extracted from donor `src/operator/garden/services/identity-service.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/scheduler-service.ts` | extracted from donor `src/operator/garden/services/scheduler-service.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/session-service.test.ts` | extracted from donor `src/operator/garden/services/session-service.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/operator/garden/services/session-service.ts` | extracted from donor `src/operator/garden/services/session-service.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/types.ts` | extracted from donor `src/operator/garden/services/types.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/types/identity.ts` | extracted from donor `src/operator/garden/services/types/identity.ts`; cut: seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/services/types/sessions.ts` | extracted from donor `src/operator/garden/services/types/sessions.ts`; cut: seam 3.6, S8 (`extraction/cuts.tsv`) |
| `src/persistence/journals/hmac-boundary.test.ts` | extracted from donor `src/persistence/journals/hmac-boundary.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/persistence/journals/hmac-boundary.ts` | extracted from donor `src/persistence/journals/hmac-boundary.ts`; cut: seam 3.8 (`extraction/cuts.tsv`) |
| `src/persistence/ledger-bounded-hydration.test.ts` | extracted from donor `src/persistence/ledger-bounded-hydration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/postgres/background-work-live-drain.integration.test.ts` | extracted from donor `src/persistence/postgres/background-work-live-drain.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/persistence/postgres/background-work-run-linkage.integration.test.ts` | extracted from donor `src/persistence/postgres/background-work-run-linkage.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/persistence/postgres/background-work-store.integration.test.ts` | extracted from donor `src/persistence/postgres/background-work-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/persistence/postgres/icp-felt-impulse-funnel-store.integration.test.ts` | extracted from donor `src/persistence/postgres/icp-felt-impulse-funnel-store.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/persistence/postgres/runtime-readiness.test.ts` | extracted from donor `src/persistence/postgres/runtime-readiness.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/postgres/schema-tenancy.integration.test.ts` | extracted from donor `src/persistence/postgres/schema-tenancy.integration.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/runtime-factory.test.ts` | extracted from donor `src/persistence/runtime-factory.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/runtime-factory.ts` | extracted from donor `src/persistence/runtime-factory.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/persistence/sessions/store-turn-record-session-refs.test.ts` | extracted from donor `src/persistence/sessions/store-turn-record-session-refs.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/sessions/store.session-tail.test.ts` | extracted from donor `src/persistence/sessions/store.session-tail.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/sessions/store.test.ts` | extracted from donor `src/persistence/sessions/store.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/persistence/sessions/store.ts` | extracted from donor `src/persistence/sessions/store.ts`; cut: seam 3.6 (`extraction/cuts.tsv`) |
| `src/primitives/llm/client-request-capability.ts` | extracted from donor `src/primitives/llm/client-request-capability.ts`; cut: seam 3.8 (`extraction/cuts.tsv`) |
| `src/primitives/llm/client.test.ts` | extracted from donor `src/primitives/llm/client.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/primitives/llm/provider-runtime-credential.test.ts` | extracted from donor `src/primitives/llm/provider-runtime-credential.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/shared/contracts/filesystem.ts` | extracted from donor `src/shared/contracts/filesystem.ts`; cut: seam 3.11 (`extraction/cuts.tsv`) |
| `src/shared/contracts/world-notes.ts` | extracted from donor `src/shared/contracts/world-notes.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/shared/event-bus.ts` | extracted from donor `src/shared/event-bus.ts`; cut: seam 3.4, 3.15, 3.17 (`extraction/cuts.tsv`) |
| `src/system/capabilities/gate.test.ts` | extracted from donor `src/system/capabilities/gate.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/capabilities/gate.ts` | extracted from donor `src/system/capabilities/gate.ts`; cut: seam 3.3 (`extraction/cuts.tsv`) |
| `src/system/config/biographical-candidate-policy.test.ts` | extracted from donor `src/system/config/biographical-candidate-policy.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/config/biographical-depth-policy.test.ts` | extracted from donor `src/system/config/biographical-depth-policy.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/config/companions-config.ts` | extracted from donor `src/system/config/companions-config.ts`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/system/config/decision-backend-config.test.ts` | extracted from donor `src/system/config/decision-backend-config.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/config/fixtures/automata-policy.pre-biography-owner.json` | extracted from donor `src/system/config/fixtures/automata-policy.pre-biography-owner.json`; cut: seam E1 (`extraction/cuts.tsv`) |
| `src/system/config/owner-file-contract-adaptation.test.ts` | extracted from donor `src/system/config/owner-file-contract-adaptation.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/config/owner-file-modes.test.ts` | extracted from donor `src/system/config/owner-file-modes.test.ts`; test edits recorded (`extraction/modified-tests.tsv`); tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/system/config/owner-file-modes.ts` | extracted from donor `src/system/config/owner-file-modes.ts`; cut: seam 3.10 (`extraction/cuts.tsv`) |
| `src/system/config/provider-runtime-factory.ts` | extracted from donor `src/system/config/provider-runtime-factory.ts`; cut: seam 3.1 (`extraction/cuts.tsv`) |
| `src/system/config/runtime-config-contracts.ts` | extracted from donor `src/system/config/runtime-config-contracts.ts`; cut: seam 3.8, 3.10, 3.13, 3.17 (`extraction/cuts.tsv`) |
| `src/system/config/selfhood-charge-boundary.test.ts` | extracted from donor `src/system/config/selfhood-charge-boundary.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/system/config/subsystem-config.test.ts` | extracted from donor `src/system/config/subsystem-config.test.ts`; tests of cut scaffolding deleted (`extraction/deleted-tests.tsv`) |
| `src/test-support/postgres-test-harness.test.ts` | extracted from donor `src/test-support/postgres-test-harness.test.ts`; test edits recorded (`extraction/modified-tests.tsv`) |
| `src/test-support/postgres-test-harness.ts` | extracted from donor `src/test-support/postgres-test-harness.ts`; test profile override (docs/extraction.md, Modified donor files) |

### Lite-new files in the extracted tree

Ports, stubs and helpers a seam cut put in place of scaffolding (each named in `extraction/cuts.tsv`), the composition root and its boot proof, the operator automata rules (seam D), and test support. Not donor files.

| Lite path (under `packages/companion/`) | Entry |
|---|---|
| `src/app/agent/companion-runtime.boot.integration.test.ts` | Lite, a Lite test (`extraction/added-tests.tsv`) |
| `src/app/agent/companion-runtime.ts` | Lite, seam 3.1, 3.11, B7, C, D, E3, E4, S8 (`extraction/cuts.tsv`) |
| `src/core/agent/substrate-agent/generated-media-stub.ts` | Lite |
| `src/core/scheduler/fleet-stagger.ts` | Lite |
| `src/core/scheduler/project-entity-id.ts` | Lite |
| `src/faculties/automata/bus/worker-write-keys.integration.test.ts` | Lite, seam D (`extraction/cuts.tsv`); a Lite test (`extraction/added-tests.tsv`) |
| `src/faculties/automata/bus/worker-write-keys.test.ts` | Lite, seam D (`extraction/cuts.tsv`); a Lite test (`extraction/added-tests.tsv`) |
| `src/faculties/memory/sleeptime-wiki-stage.ts` | Lite |
| `src/faculties/shards/context-text.ts` | Lite |
| `src/faculties/subagents/host-execution.test.ts` | Lite, seam D (`extraction/cuts.tsv`); a Lite test (`extraction/added-tests.tsv`) |
| `src/faculties/subagents/host-execution.ts` | Lite, seam D (`extraction/cuts.tsv`) |
| `src/operator/garden/admin-scheduler-contract.ts` | Lite, seam S8 (`extraction/cuts.tsv`) |
| `src/operator/garden/request-capability-versions.ts` | Lite, seam S8 (`extraction/cuts.tsv`) |
| `src/shared/contracts/api-health.ts` | Lite |
| `src/shared/contracts/channel-prompt-port.ts` | Lite, seam 3.17 (`extraction/cuts.tsv`) |
| `src/shared/contracts/fatigue-event-types.ts` | Lite, seam 3.17 (`extraction/cuts.tsv`) |
| `src/shared/contracts/icp-gateway-contract.ts` | Lite |
| `src/shared/contracts/image-vision-review.ts` | Lite |
| `src/shared/contracts/intake-screening-port.ts` | Lite |
| `src/shared/contracts/intake-sink-gate-port.ts` | Lite |
| `src/shared/contracts/notification-port.ts` | Lite |
| `src/shared/contracts/participation-types.ts` | Lite, seam 3.17 (`extraction/cuts.tsv`) |
| `src/shared/contracts/personal-projects-port.ts` | Lite |
| `src/shared/contracts/reaction-surface.ts` | Lite, seam 3.12 (`extraction/cuts.tsv`) |
| `src/shared/contracts/runtime-service-health.ts` | Lite |
| `src/shared/contracts/skills-runtime-port.ts` | Lite |
| `src/shared/contracts/speaking-arbiter-types.ts` | Lite |
| `src/shared/contracts/wiki-context.ts` | Lite |
| `src/shared/telemetry/provider-cost-extraction.ts` | Lite |
| `src/system/capabilities/pre-tool-hook.ts` | Lite |
| `src/system/config/fleet-auth-vocabulary.ts` | Lite, seam S8 (`extraction/cuts.tsv`) |
| `src/system/config/inner-life-config.ts` | Lite, seam 3.10, B7, E4 (`extraction/cuts.tsv`) |
| `src/test-support/in-memory-automata-bus.ts` | Lite, seam D (`extraction/cuts.tsv`) |
| `src/test-support/static-credential-vault.ts` | Lite test support: donor `boundary/custody/credential-vault.ts:94-119`, unchanged, over the credential contract (B7) |

### Cut

Donor files that were carried into the tree and deleted again in B7 (`extraction/vendored-files.txt` keeps one row per file), by donor area and kind. Donor files outside the closure that no extracted file imports were never copied (the closure is `extraction/closure-files.txt`).

| Donor path | Entry |
|---|---|
| `config/backup.seed.json` | cut (seed-deleted, 1 file) |
| `config/charge-policy.seed.json` | cut (seed-deleted, 1 file) |
| `config/fleet-auth.seed.json` | cut (seed-deleted, 1 file) |
| `config/intake-l1-rules.json` | cut (seed-deleted, 1 file) |
| `config/mcp-servers.seed.json` | cut (seed-deleted, 1 file) |
| `config/models.seed.json` | cut (seed-deleted, 1 file) |
| `config/partner-affect-shadow.seed.json` | cut (seed-deleted, 1 file) |
| `config/places.seed.json` | cut (seed-deleted, 1 file) |
| `config/providers.seed.json` | cut (seed-deleted, 1 file) |
| `config/skills.seed.json` | cut (seed-deleted, 1 file) |
| `src/app/agent/` | cut (scaffolding, 4 files) |
| `src/app/cli/` | cut (scaffolding, 1 file) |
| `src/app/gateway/` | cut (source-text, 1 file) |
| `src/app/operator/` | cut (source-text, 1 file) |
| `src/boundary/custody/` | cut (scaffolding, 1 file) |
| `src/boundary/fleet-auth/` | cut (scaffolding, 23 files) |
| `src/boundary/gateway/` | cut (asset-deleted, 4 files) |
| `src/boundary/gateway/` | cut (scaffolding, 163 files) |
| `src/boundary/integrations/` | cut (scaffolding, 20 files) |
| `src/boundary/sandbox/` | cut (scaffolding, 18 files) |
| `src/channels/api/` | cut (scaffolding, 34 files) |
| `src/channels/backplane/` | cut (scaffolding, 18 files) |
| `src/channels/external/` | cut (scaffolding, 8 files) |
| `src/channels/plugins/` | cut (scaffolding, 6 files) |
| `src/channels/shared/` | cut (scaffolding, 1 file) |
| `src/core/agent/` | cut (cut, 12 files) |
| `src/core/agent/` | cut (scaffolding, 9 files) |
| `src/core/cogsec/` | cut (asset-deleted, 10 files) |
| `src/core/cogsec/` | cut (scaffolding, 56 files) |
| `src/core/participation/` | cut (cut, 1 file) |
| `src/core/participation/` | cut (scaffolding, 9 files) |
| `src/core/scheduler/` | cut (scaffolding, 2 files) |
| `src/core/session/` | cut (cut, 2 files) |
| `src/core/tools/` | cut (scaffolding, 15 files) |
| `src/faculties/file-ingest/` | cut (asset-deleted, 6 files) |
| `src/faculties/file-ingest/` | cut (scaffolding, 5 files) |
| `src/faculties/shards/` | cut (scaffolding, 13 files) |
| `src/faculties/skills/` | cut (scaffolding, 10 files) |
| `src/faculties/wiki/` | cut (scaffolding, 20 files) |
| `src/operator/garden/` | cut (scaffolding, 31 files) |
| `src/operator/tool-health/` | cut (scaffolding, 1 file) |
| `src/persistence/backups/` | cut (scaffolding, 23 files) |
| `src/persistence/cutover.ts` | cut (scaffolding, 1 file) |
| `src/persistence/pinned-filesystem.ts` | cut (scaffolding, 1 file) |
| `src/persistence/postgres/` | cut (cut, 1 file) |
| `src/persistence/postgres/` | cut (scaffolding, 74 files) |
| `src/persistence/repair/` | cut (scaffolding, 1 file) |
| `src/persistence/sessions/` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-bootstrap.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-execution.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-files.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-io.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-planning.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-receipt.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration-recovery.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-migration.ts` | cut (scaffolding, 1 file) |
| `src/persistence/system-owner-fleet-owner-validation.ts` | cut (scaffolding, 1 file) |
| `src/persistence/workspaces/` | cut (scaffolding, 2 files) |
| `src/primitives/images/` | cut (scaffolding, 17 files) |
| `src/primitives/llm/` | cut (scaffolding, 3 files) |
| `src/primitives/voice/` | cut (scaffolding, 11 files) |
| `src/shared/cache/` | cut (scaffolding, 1 file) |
| `src/shared/companion-display-identity.ts` | cut (scaffolding, 1 file) |
| `src/shared/contracts/` | cut (cut, 1 file) |
| `src/shared/contracts/` | cut (scaffolding, 13 files) |
| `src/shared/escalation/` | cut (scaffolding, 2 files) |
| `src/shared/log-rate-limit.ts` | cut (scaffolding, 1 file) |
| `src/shared/net/` | cut (scaffolding, 2 files) |
| `src/shared/observability/` | cut (scaffolding, 8 files) |
| `src/shared/process-termination-policy.ts` | cut (scaffolding, 1 file) |
| `src/shared/telemetry/` | cut (scaffolding, 9 files) |
| `src/shared/utils/` | cut (cut, 1 file) |
| `src/shared/utils/` | cut (scaffolding, 4 files) |
| `src/system/capabilities/` | cut (cut, 2 files) |
| `src/system/capabilities/` | cut (scaffolding, 4 files) |
| `src/system/config/` | cut (cut, 5 files) |
| `src/system/config/` | cut (scaffolding, 20 files) |
| `src/system/fleet-lifecycle/` | cut (scaffolding, 11 files) |
| `src/system/lifecycle/` | cut (scaffolding, 5 files) |
| `src/system/modules/` | cut (scaffolding, 3 files) |
| `src/system/security/` | cut (scaffolding, 1 file) |
| `src/system/settings-tools.ts` | cut (scaffolding, 1 file) |
| `src/system/settings.ts` | cut (scaffolding, 1 file) |
| `src/system/settings/` | cut (scaffolding, 9 files) |
| `src/test-support/fixtures/` | cut (asset-deleted, 2 files) |
| `src/test-support/integration-timeout-registry.json` | cut (asset-deleted, 1 file) |
| `src/test-support/lifecycle-kubernetes-settings.ts` | cut (test-support-deleted, 1 file) |

## Cut in Step C (Lite code)

Lite's own companion core and its storage, harness and transport internals
were deleted when Lite moved onto the extracted core. They had been written
new for Lite from the donor's contracts; no donor code was copied into them.
The donor's own implementation replaces each one.

| Lite path (before Step C) | Entry |
| --- | --- |
| `packages/core/src/*` (124 files: the tool inventory, ingress and turn lifecycle, dispatch, privacy, sessions, contacts, identity, memory, episodes, journals, emotion and self-model, concerns, activity, automata, free time, schedule, backup) | cut in Step C; the donor core in `packages/companion` |
| `packages/adapters/src/*` (32 files: the JSONL session archive and history chain, Postgres stores and migrations 0001-0004, state backup) | cut in Step C; the donor persistence in `packages/companion/src/persistence` |
| `packages/pi/src/{companion-harness,loop,context,render,settlement,turn-settler,tools,worker-host,inference}.ts` | cut in Step C; the donor `SubstrateAgent` is the harness |
| `packages/mcp/src/{catalog,schema,results,callers,internal-turns,core}.ts`, `arguments/*` | cut in Step C; the donor tool catalog (`packages/lifecycle/src/tools.ts`) |
| `packages/lifecycle/src/{core,delegated}.ts` | cut in Step C; host-driven turns (`host-turns.ts`, `bridge.ts`) |
| `apps/standalone/src/{adapters,capabilities,core,harness,local-host,stacks,storage,tick-loop,transports}.ts` | cut in Step C; donor `startCompanionRuntime` |
| `integrations/hermes/psfn_lite/internal.py` | cut in Step C, with delegated internal turns |
| `scripts/bench/{inference,latency,lite-host}.ts` | cut in Step C; they measured the Lite runtime |

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
