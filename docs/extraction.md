# Donor extraction record

PSFN Lite is an extraction of the donor PSFN Framework's companion core,
packaged small enough to embed. This file is the running record of that
extraction: what was copied, the donor test baseline it must reproduce, every
seam cut, every deleted or modified test, package changes and the measured
size. The plan it follows is the read-only extraction plan (closure, seams,
batches B1-B7); the donor's code, docs and history are the spec.

- Donor: `psfn-framework` at `e6a9546051f4e92bf7218b133b4523ac53a797c0`.
- Extracted tree: `packages/companion` (package `lite-companion`), laid out as
  `packages/companion/src/<donor src path>` so relative imports are unchanged.
- Machine-readable records: `packages/companion/baseline.json` and
  `packages/companion/extraction/` (closure, levels, seams, test selection,
  excluded tests, vendored files, deleted tests, comparison script).

## Status

| Step | State |
|---|---|
| A0 baseline | Recorded (below). |
| A path-preserving copy | Done: closure, selected tests, test-support and the temporarily vendored scaffolding; typechecks with the donor compiler options; the extracted tests reproduce the baseline in a clean full run (Equivalence, below). |
| B1 seam cuts (3.7, 3.8, 3.13, 3.14, 3.16, 3.18) | Done (Seam cuts, below). |
| B2 seam cuts (3.4, 3.5, 3.6) | Done (Seam cuts, below). |
| B3-B7 | Not started. |

## Closure (Step A0)

Computed over the plan's relative-import edge list (`edges.json`, 22,478
edges), following every import kind (value, type, dynamic, re-export,
side-effect) from the seeds and stopping at scaffolding.

**Reproduction first.** With the plan's 17 seed areas and its scaffolding stop
set (`boundary/{custody,fleet-auth,gateway}`, `channels`, `core/agent/arbiter`,
`core/cogsec`, `core/eval`, `core/icp`, `core/scheduler/fleet-maintenance-*`,
`faculties/{introspection,shards,skills,wiki}`, `operator`,
`persistence/postgres/fleet-auth`, `primitives/{images,voice}`) the computation
reproduces the plan's 1,041 files, 182 seam statements and 72 targets exactly.

**Edge-list corrections.** The edge list resolves JSON imports as
`<file>.json/index.ts` (the plan's file list carries one such phantom,
`src/system/config/intake-screening-pool-contract.json/index.ts`); they are
mapped to the real `.json` file. Two spawned worker entry points are reached
through `new URL(...)` + `fork()`, not an import, and were missing: edges
`turn-record-recovery.ts -> turn-record-recovery-worker.ts` and
`turn-tombstone-authority.ts -> turn-tombstone-authority-worker.ts` were added
(they bring `turn-record-recovery-quarantine.ts` too). With these corrections
the plan's seeds give 1,044 files / 301,974 LOC.

**Operator KEEP seeds added:** `core/eval/observer-sidecar` (EmoSim felt
impulse), `core/icp` (felt-impulse and ICP adapters), `faculties/introspection`,
`faculties/shards/fold-review.ts`, `faculties/shards/result-lineage.ts`, and
explicitly `faculties/memory/biographical` and `faculties/memory/social-graph`
(both were already inside `faculties/memory`). The automata bus
(`faculties/automata/bus`) was already a seed.

| | Files | LOC (`wc -l`, non-test `.ts` + imported `.json`) |
|---|---:|---:|
| Plan closure (as published) | 1,041 | 301,077 |
| Plan seeds, corrected edges | 1,044 | 301,974 |
| **Recomputed closure (with KEEP seeds)** | **1,096** | **319,169** |
| Added by the KEEP seeds | 52 | 17,195 |

Added files by area: `core/icp` 21, `core/eval` 16, `faculties/introspection`
11, `faculties/shards` 2, `persistence/postgres` 1
(`icp-shared-autonomy-store.ts`), `shared/telemetry` 1.

Seams after the recompute: **171 import statements (102 type-only) into 62
scaffolding files** (`extraction/closure-seams.tsv`). By area: `core/cogsec`
85, `boundary/gateway` 16, `primitives/images` 14, `faculties/skills` 9,
`faculties/shards` 8, `channels/backplane` 8, `core/scheduler`
(fleet-maintenance) 6, `faculties/wiki` 5, `core/agent/arbiter` 4,
`boundary/custody` 4, `operator/tool-health` 3, `channels/shared` 3,
`primitives/voice` 2, `boundary/fleet-auth` 2, `persistence/postgres/fleet-auth`
1, `channels/api` 1.

Topological levels: 39 (`extraction/closure-levels.tsv`). Two import cycles:
the plan's 9-file event-bus cycle (all closing edges type-only), and a 13-file
cycle through `persistence/sessions/store.ts` and the turn-record recovery
worker that exists only because of the added spawn edge (the worker is forked,
not imported).

The closure still contains areas the operator ruled scaffolding (fatigue,
participation types, capability tiers, charge, config for scaffolding owners):
they are cut in Step B, not before.

## Test baseline (Step A0)

**Selection** (`extraction/tests.tsv`, 735 files). A donor test is selected
when its sibling source file is in the closure (575, the plan's "colocated"
convention) or when it lives in a closure directory, has no sibling source and
imports at least one closure file directly (160). Twelve tests in closure
directories are not selected (`extraction/excluded-tests.tsv`): one imports
the operator Garden UI (`admin-ui/`), the other eleven import no closure file
(repository source scans such as `shadow-isolation`, `migrations-facade`, and
the fleet-maintenance coordinator test). Tests whose sibling source is
scaffolding (164) are not selected.

**How it was run.** In a throwaway donor clone at `e6a9546` with the donor's
own installed `node_modules`: node 24.22.1, npm 11.17.0, vitest 4.1.12,
vite 7.3.7 (the donor override). The donor test settings (`globals`, node
environment, 10 s `testTimeout`, the donor setupFile) with `include` = the
selection; unit and Postgres-harness tests in one process (the donor's
`PSFN_VITEST_PROFILE` only switches the include list). Postgres tests use the
donor harness with two isolation changes in the throwaway clone only: the
harness `profile` constant reads `PSFN_POSTGRES_TEST_PROFILE_OVERRIDE` (so the
computed container names never match the warm `test-postgres-*` containers
other checkouts own), and `TMPDIR` points to a private directory (so the slot
lock files are private). Only containers labelled with that profile were
created and then removed.

**Result** (`packages/companion/baseline.json`, canonical run `final-a2`):
**735 files, 9,485 tests: 9,485 passed, 0 failed, 0 skipped.** The donor has no
skipped tests in this selection.

Evidence about stability:

- Three runs with a long `TMPDIR` (a 90-character scratch path) failed one
  test every time: `system/config/owner-file-contract-adaptation.test.ts >
  boots an owner file whose humanEscalation block predates retention`. The
  warning it asserts embeds the temp path and is truncated by the donor's log
  length budget. It passes with a short `TMPDIR` (reproduced in isolation both
  ways). The baseline is therefore recorded with a short `TMPDIR`, and Lite
  gives the extracted tests one (below).
- Under load, cold harness containers made `beforeAll` exceed the donor's
  default 10 s hook timeout in some runs (2 to 4 files); warm containers did
  not.
- Lost test forks. In the baseline runs and the first Lite runs, a vitest
  fork sometimes died mid-file ("Worker exited unexpectedly"; the rest of
  that file left `pending`; once the main process then failed with `write
  EPIPE`, which is it sending to the already dead fork). It hit a different
  file each time (memory and biographical Postgres stores, fleet
  observability, background-work drain, `retrieval/budget.test.ts`), in the
  donor clone and in Lite alike. Separately, a vitest main process was killed
  with exit 137 several times. The last of those, at 21:33Z, was the host
  terminal daemon restarting every terminal. The others were not explained.
  **Every one of those runs used vitest's default fork count**: none set
  `maxWorkers`, and vitest 4.1.12's default for `run` is
  `availableParallelism() - 1`, which is 31 on the 32-core workstation. That
  is above the workstation's 16-fork budget. With `maxWorkers: 16` (now in
  both vitest configs, below), seven runs in a row lost nothing: one
  `companion` project run, five full runs with exit instrumentation, and the
  plain final run. The instrumentation was a `--import` preload that logged
  every `process.exit`/`reallyExit`/`abort`, every catchable fatal signal, and
  the exit code and signal of every `fork()` child. In 5,378
  forks, vitest stopped each one with its normal `SIGTERM` or it exited 0.
  The exact way forks died at 31 was not isolated. These causes were ruled
  out: kernel OOM (`/proc/vmstat` `oom_kill 0` since boot, `oom_kill 0` in
  `memory.events` at every cgroup level), systemd-oomd (no journal entries),
  native crashes (no node core dumps), and JS-level exits and kills (the
  earlier kill-logging run and the preload above). Lost forks and killed runs
  are not test outcomes and are not counted. `baseline.json` lists the
  completed baseline runs and their non-passed tests: all `pending` or hook
  timeouts, never an assertion failure, apart from the `TMPDIR` case above.

## Extracted tree (Step A)

Copied byte-identical from the donor commit with `git archive` (verified
blob-by-blob; the single modified file is listed below):

| Part | Files | LOC |
|---|---:|---:|
| Closure (minus the card importer) | 1,095 | 318,894 |
| Selected tests (minus the card importer test) | 734 | 285,609 |
| Vendored scaffolding (temporary) | 788 | 237,889 |
| Vendored test-support (`src/test-support`, `*.test-fixtures.ts`, `*.test-support.ts`) | 21 | 6,405 |
| Donor non-TS assets under `src/` (goldens, conformance fixtures, JSON) | 46 | 8,338 |
| Source-text fixtures (read by source-scan tests, never compiled) | 5 | 3,262 |
| Donor seed config (`packages/companion/config/`) | 19 | |

`extraction/vendored-files.txt` lists every vendored file with its kind.

- **Vendored scaffolding: 788 files, not the plan's ~282.** The closure's own
  sources need 255 scaffolding files (80,205 LOC; the plan's 282 for its
  smaller closure). The selected tests need the rest: they build fixtures
  from scaffolding, e.g. `core/agent/substrate-agent.test.ts` pulls 274 extra
  files and `core/internal-role-envelopes/runtime-wiring.test.ts` 123
  (composition and fleet-auth). All of it leaves in Step B.
- **Source-text fixtures** (`src/app/agent/{scheduler-runtime,automata-background-work-lifecycle}.ts`,
  `src/app/agent/startup/free-time-lane.ts`, `src/app/{gateway,operator}/main.ts`):
  four donor tests read these composition files as text to pin wiring; they
  are excluded from the package typecheck and imported by nothing.
- **Seed config**: the donor `config/*.seed.json`, `intake-l1-rules.json`,
  `places.seed.json`; the runtime and tests read them from the working
  directory. Delivery-gate baselines (`knip-*`, `typecheck-baseline`,
  `dependency-cycle-baseline`, `duplicate-type-baseline`,
  `todo-comment-baseline`, `actor-terminology-baseline`,
  `identity-literal-scan-allowlist`, `import-graph-seams`, `semgrep/`) and
  `places.test.json` were not copied (nothing in the tree reads them), nor
  `src/test-support/integration-timeout-registry.json` (read only by a
  test-support gate test that is not extracted).
- `packages/companion/README.md` carries the donor README's "Self-Direction
  Tool Surfaces" table verbatim; the North Star and Values tool tests check it.

**Cut at copy:** `src/core/identity/importer.ts` (the character card importer,
275 LOC) is in the closure only because it sits in a seed directory; its only
importers are `operator/garden` and `app/maintenance`. The operator ruled the
importer scaffolding and `@character-foundry` not allowed, so it and its test
were not copied. Behaviour change for the companion core: none (nothing in
the core called it).

### Modified donor files

| File | Change | Why |
|---|---|---|
| `src/test-support/postgres-test-harness.ts:108` | `profile: process.env.PSFN_POSTGRES_TEST_PROFILE_OVERRIDE?.trim() \|\| 'tmpfs-v3-max-connections'` | Container names derive from the profile; without an override the harness reuses (and resets) warm containers that other checkouts own. Test infrastructure only. |

Step B seam cuts edit core source files; every edit is a row in
`packages/companion/extraction/cuts.tsv` (site, cut type, behaviour change),
summarised per batch under Seam cuts. B2 edited
`core/agent/substrate-agent.ts` and `substrate-agent/{egress-tool-guard,turn-execution-runtime,turn-execution-adapter,turn-support-runtime}.ts`,
`substrate-agent/turn-execution/{contracts,prompt-assembly}.ts`,
`core/artifacts/sensitivity-egress.ts`, `core/cogsec/memory-candidacy.ts`
(promoted, then split), `core/scheduler/{post-turn-runtime,reflection-runtime-contracts}.ts`,
`core/scheduler/post-turn-runtime/scheduler-lanes.ts`,
`core/session/intake-sink-gating.ts`, `core/session/manager/context-builder.ts`
and `persistence/sessions/store.ts`, and deleted
`persistence/sessions/store/{cogsec-operations,cogsec-journal-helpers}.ts`.
Two vendored scaffolding files were adjusted only so they still typecheck
(`app/startup/composition/composition.ts`,
`operator/garden/services/types/sessions.ts`); both leave in B7. The Step A0
closure lists (`closure-files.txt`, `closure-levels.tsv`, `closure-seams.tsv`,
`tests.tsv`) are the Step A record and are not pruned when a cut deletes a
file.

Donor test files are modified by deleting `it()` blocks (and a `describe()`
the deletions left empty, which vitest rejects), and in two cases by removing
a cut-path assertion from a test whose subject is kept (Deleted and modified
tests, below).

### Test configuration differences (Lite vs donor)

`packages/companion/vitest.config.ts` keeps the donor's `globals`, node
environment and 10 s `testTimeout`. Differences:

- The donor setupFile (`src/test-support/fleet-auth-persistence-boundary.ts`)
  is not used: it acts only on `persistence/postgres/fleet-auth/` test paths,
  none of which are extracted, and it imports a gateway module.
- `vitest.setup.ts` makes `packages/companion` the working directory: donor
  tests resolve `config/`, `README.md` and `src/...` from `process.cwd()`.
- `vitest.global-setup.ts` gives each run its own harness profile
  (`lite-companion-<pid>-<token>`) and a short private `TMPDIR`
  (`/tmp/lc-<pid>-*`); teardown removes exactly that profile's containers. It
  also removes the containers and temp directories of earlier Lite runs whose
  process is gone (killed runs never reach teardown), matching only that
  profile pattern.
- `hookTimeout` is 120 s (Lite's harness start budget) instead of vitest's
  default 10 s, because each run starts fresh containers. No assertion
  changes.
- `maxWorkers` is 16 (also in the root `vitest.config.ts`; the two projects
  share one pool, so the values must match). The donor baseline used vitest's
  default (31 forks here). Fork count does not change any expected status,
  because every baseline test passed. It only removes the lost forks
  described in the baseline section.

### Equivalence

`node packages/companion/extraction/compare-baseline.mjs <vitest json report>`
compares a run with `baseline.json` minus `extraction/deleted-tests.tsv`.

Step A result: the plain validation command `mise exec node@24.22.1
npm@11.17.0 -- npx vitest run` (both projects, with a JSON reporter added),
2026-11-08 22:05Z, finished with exit 0: **786 files and 9,915 tests, all
passed**. `lite` had 52 files and 437 tests; `companion` had 734 files and
9,478 tests. Comparison: `matched: 9478`, `equivalent: every remaining
baseline test has its baseline status`. That is the baseline's 9,485 tests
minus the 7 deleted card-importer tests. The five instrumented full runs
before it gave the same totals. Afterwards, no `lite-companion-*` harness
containers and no `/tmp/lc-*` directories were left.

Step B2 result (same command, 2026-11-08 22:56Z): exit 0, **785 files and
9,854 tests, all passed** (`lite` 52 files / 437 tests, `companion` 733 files
/ 9,417 tests). Comparison: `deleted: 2 files, 68 tests; matched: 9417`,
`equivalent: every remaining baseline test has its baseline status`. That is
the baseline's 9,485 tests minus 68 deleted (7 card importer, 3 in B1, 58 in
B2); the 2 edited tests are among the 9,417 matched. No `lite-companion-*`
containers and no `/tmp/lc-*` directories were left.

## Deleted and modified tests

Machine-readable list: `packages/companion/extraction/deleted-tests.tsv`
(file, full test name or `*`, reason, seam). Edited tests:
`packages/companion/extraction/modified-tests.tsv` (file, full test name, the
exact lines removed, reason, seam). compare-baseline counts an edited test as
matched, so that file is its only record. No kept assertion was changed or
relaxed.

| Test | Reason | Seam |
|---|---|---|
| `src/core/identity/importer.test.ts` (7 tests) | Character card importer cut; `@character-foundry` not allowed | card importer, `core/identity/importer.ts:12` |
| `src/core/agent/substrate-agent/turn-execution-runtime.test.ts` > `handleMessageForTurn generated media delivery`: "turns successful media tool results into response attachments for chat egress", "queues high-sensitivity generated media instead of sending it to a public audience", "recovers response attachments from tracked paid deliverables when the turn transcript misses the tool result" (3 tests) | They assert that image tool results become reply attachments (and the sensitivity gating of those attachments); the image tools and generated-media collection are cut. The fourth test in that block (no-reply drops a paid deliverable, no attachments) still passes and stays. | 3.13 |

| `src/core/agent/substrate-agent/egress-tool-custody.test.ts` (16 of 18 tests; the emptied `tool egress custody mid-turn` describe removed) | They assert custody delivery records and custody holds on the tool-egress surface; the delivery recorder is cut. The two kept tests ("stays a calm denial when the payload has no canonical digest", "leaves an unresolvable social destination to the existing fail-closed gate") still pass. | 3.6 custody |
| `src/core/artifacts/sensitivity-egress-custody.test.ts` (5 of 6) | Artifact-share custody records and holds; the custody deps and the `held` disposition are cut. | 3.6 custody |
| `src/core/agent/substrate-agent/turn-support-runtime.test.ts` > `TurnSupportRuntime custody snapshots (psfn-framework-ccgdz.1)` (4, describe removed) | `recordTurnCustodySnapshot` and the custody store are cut. | 3.6 custody |
| `src/core/agent/substrate-agent/turn-execution-runtime.test.ts`: 4 in `MCP disclosure context` (custody correlation/proof, snapshot write, named absence on a lost write, tool-result custody edge into the snapshot) and "keeps shadow-mode observability active by retaining the canary marker" | Custody store and canary are cut. | 3.6 custody, canary |
| `src/core/session/intake-sink-gating.test.ts` (3) and `context-builder.channel-bond.test.ts` "terminates downstream context consumers with a datamarked wrapper" | Read-time data marking is cut. | 3.4 marking |
| `src/core/session/manager/context-builder.test.ts` "includes relevant safe CogSec notices without sealed refs or dirty text" | The CogSec event notices are cut (no core caller passed events). | 3.4 events |
| `src/persistence/sessions/store.test.ts` (6) and `store/cogsec-operations.test.ts` (whole file, 2) | The CogSec tombstone, compaction-invalidation and regeneration writes are cut. | 3.6 session ops |
| `src/faculties/memory/writer.test.ts` (4), `core-memory/tools.test.ts` (1), `memory/extraction/orchestrator.test.ts` (1), `memory/sleeptime-agent.test.ts` (1) | Each asserts a rejection by a cut candidacy pattern class. The sleeptime test's "keeping safe memory writes" half is the control for that skip, so the test is deleted, not edited. | 3.5 split |
| `src/persistence/sessions/store-turn-record-session-refs.test.ts` (6; the emptied `sm9l` describe removed), `src/core/session/manager.test.ts` "withholds tombstoned origin content before live cross-channel context assembly", `src/persistence/sessions/store.session-tail.test.ts` "the second fence still lands when a step AFTER the journal rewrite throws" | **Not clean scaffolding deletions.** They assert kept read-side behaviour (tombstone gating in session reads, turn records, wire bodies and the Loom; the session-tail post-rewrite fence) but build their scenario through `applyCogSecTombstones`, which is cut. Lite has no path that writes a CogSec tombstone, so that read guard is unreachable in Lite. The session-tail fence's exception safety on a failing post-rewrite step had no other test; `redactTurn` tests cover the fence bumps only. Recorded as an open question. | 3.6 session ops |

Edited (`modified-tests.tsv`): `turn-execution-runtime.test.ts` "moves system
context into the prompt system lane instead of assistant history in
observability snapshots" and "appends the current datetime anchor at the end
of the provider system prompt". Each spliced the canary block into its
expected system prompt; only that element (and, in the first, the canary
`toMatch` line) is removed. The donor always armed a canary, so the expected
prompt now equals the donor's `assembleTurnPrompt` output with `canaryToken`
undefined (`prompt-assembly.ts:537`), not any donor runtime configuration.

## Seam cuts

Every cut has a row in `packages/companion/extraction/cuts.tsv` (seam, site
file:line, cut type, detail, behaviour change). `node
packages/companion/extraction/remaining-seams.mjs [--summary]` lists the core
tree's remaining imports of vendored scaffolding; Step B7 ends with it empty.
Core for that check = the Step A0 closure, plus donor files **promoted** to
core (kind `promoted` in `vendored-files.txt`: self-contained files a cut kept
unchanged at their donor paths), plus the Lite files the cuts add.

Cut types: **redirect** (the same donor function or type, imported from the
closure module that already defines it); **type copy** (type-only declarations
copied verbatim into a new closure file); **promote** (a self-contained donor
file kept unchanged at its path); **move verbatim** (donor functions copied
unchanged into a closure file, without the scaffolding around them); **stub**
(a scaffolding value replaced by its result for the single host);
**delete call path**.

### B1 (3.7, 3.8, 3.13, 3.14, 3.16, 3.18)

Remaining seam statements: 171 before, 150 after.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.7 lifecycle | None needed: `system/lifecycle/{turn-contention,outbound-reply-dedupe,notifications}.ts` are already closure files at their donor paths and import only core. The five other lifecycle files stay vendored (no core importer). The notification port is 3.2 (B3). | none |
| 3.8 keyring | Redirect `persistence/journals/hmac-boundary.ts:1-2`, `primitives/llm/client-request-capability.ts:34-37`, `system/config/runtime-config-contracts.ts:7` from `boundary/custody/credential-vault.ts` to `shared/contracts/credential-contracts.ts`, which defines the same port and resolvers (the vault module re-exports them, `credential-vault.ts:39-49`). | none: the keyring still reads `GATEWAY_SESSION_HMAC_KEYS` / `_KEY` / `_ACTIVE_VERSION` from the environment when no vault is passed. The names are kept, not renamed. |
| 3.13 images | Type copy of the vision-review port into `shared/contracts/image-vision-review.ts` (5 sites). Promote `primitives/images/{request-context,vision-policy,attachment-claim-guard}.ts` (self-contained; the claim guard runs on text turns). Stub `generated-media.ts` with `core/agent/substrate-agent/generated-media-stub.ts` (4 verbatim declarations; the three collectors return `[]`). `runtime-config-contracts.ts:1` (image config fields) is deferred to the config cut (B5). | A reply never carries an image-tool attachment and the paid-image warnings never log: the image tools are cut, so no turn has an image tool result. Text turns unchanged. 3 tests deleted. |
| 3.14 telemetry, charge | Move verbatim: the pure provider-cost parsers the API embedding provider uses (`faculties/memory/embedding.ts:18-21`) into `shared/telemetry/provider-cost-extraction.ts` (copied from `boundary/gateway/llm-cost-capture.ts:32-66,72-162`, diff-checked). Telemetry sinks, run-charge and charge policy are closure-internal optional ports, so there is nothing else to cut here. | none. The operator ruling to cut charge and capability tiers is not a closure seam (both are inside the closure); it is carried to B5 and the closure recompute. |
| 3.16 observer | Superseded by the operator ruling (EmoSim / felt impulse KEEP): `core/eval/observer-sidecar` is a closure seed, so no dispatch call is deleted. | none |
| 3.18 Garden | Type copy of `RuntimeServiceHealthStatus` into `shared/contracts/runtime-service-health.ts` (3 sites). `emitGardenQueueChanged` is in the composition root `app/agent/scheduler-runtime.ts:57` (B6). | none |

Promoted files bring no tests: their donor tests were not in the Step A0
selection, so the baseline does not include them.

### B2 (3.4, 3.5, 3.6)

Remaining seam statements: 150 before, 89 after part 1, 65 after part 2. No
remaining seam targets `core/cogsec` or the gateway intake modules.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.4 intake/sink | Ports, not stubs: the screening and sink-gate types are copied verbatim into `shared/contracts/intake-screening-port.ts` and `intake-sink-gate-port.ts`; the donor's own firewall-off mode is a null `IntakeScreeningService` / `IntakeSinkGate`, which is the Lite default. `derived-content.ts` and `tool-result-provenance.ts` are promoted. Read-time data marking (`intake-sink-gating.ts`) and the CogSec event notices (`context-builder.ts`) are deleted. | Marking: an allowed entry with a persisted marking plan is no longer wrapped when a host wires an enforce-mode sink gate. Notices: none (no core caller passed events, so the donor section was already empty). 5 tests deleted. |
| 3.5 candidacy | Split (`memory-candidacy.ts`, promoted then edited). Kept: empty-text rejection; the `memory_write` sink-gate decision (wrong sink throws, denial rejects as D); the intake-firewall notice exclusion; the runtime-fallback exclusion (charter Law 17, commit 5aa730317); then the A/B allow labels (`B_relationship_state` on relationship signals, otherwise `A_harmless_fact`). Cut: E (obfuscation and executable-instruction patterns), D by policy/security pattern, D for payload-bearing CogSec notices, the safe-CogSec-notice allow, and C persona review. The risk-class type keeps all five labels. | Text that matched a cut pattern is allowed as A or B instead of rejected or held for review. Self-report fidelity unchanged. 7 tests deleted. |
| 3.6 privacy modules | Kept (promoted): `assessDisclosure` and the lineage it needs (`disclosure/{contracts,decision,generation-lineage,mcp-turn-context,egress-composition}.ts`), the SOFT contact block list, the tombstone reader, the firewall notice templates, the receipt contract. Deleted call paths: canary; custody snapshot, context manifest and egress delivery records (turn runtime, support runtime, adapter, contracts, substrate agent, egress tool guard, artifact egress); the drift-velocity and second-arrow lanes; the session store's CogSec write operations (two store files deleted). | Custody: none against the donor's no-custody-store mode, derived below. Canary: the prompt loses the `cogsec.canary` block. Drift lanes: not registered (the donor registered them only when a host passed their bundles). Session ops: Lite cannot write a CogSec tombstone. 46 tests deleted, 2 edited. |

**Custody is inert without a store (derivation).** With no delivery recorder,
the donor's `egress-tool-guard.ts` resolved every custody hold reason to
either "withholds only when the composed decision denies" (non-durability
reasons) or "shadow posture, never withholds" (durability reasons, since
`posture` defaulted to `shadow`), so `held === !composed.allowed`; its
`recordEgress` returned `true`, so the record-first `commit` always allowed.
`sensitivity-egress.ts` ran its hold only when `deps.custody` was set, and the
turn runtime set it only with a recorder. `TurnSupportRuntime` returned
`{ absenceReason: 'no_custody_store' }` and an undefined manifest ref without a
store. Lite keeps exactly those results: the guard returns the composed
decision with no commit (which `gate.ts` treats as allowed), and the turn
record carries `custodySnapshotAbsence: 'no_custody_store'` with no snapshot or
manifest ref.

**Social egress disclosure needs a sink gate.** The guard composes the
disclosure destination check with the sink gate and returns `null` when no
sink gate is wired (donor `egress-tool-guard.ts:91-92`, unchanged). In Lite's
default (no sink gate) the disclosure check therefore does not run on tool
egress; it runs when a host wires an `IntakeSinkGate`. `assessDisclosure`
itself is kept unchanged for that host and for the MCP disclosure floor.

Tests that construct the vendored sink gate or screening service (for example
`createIntakeSinkGate` in `context-builder.channel-bond.test.ts`) still pass
against the vendored implementation and leave, or move to the port, in B7.

## Package changes

Exact donor versions. Root `package.json` (Lite installs at the root) and, for
the core set, `packages/companion/package.json`:

| Package | Version | Role |
|---|---|---|
| `@sinclair/typebox` | 0.34.48 | core |
| `uuid` | 11.1.1 | core |
| `js-tiktoken` | 1.0.21 | core |
| `winston` | 3.19.0 | core |
| `@huggingface/transformers` | 4.2.0 | core (operator ruling: allowed) |
| `json-rpc-2.0` | 1.7.1 | temporary, vendored scaffolding |
| `ws` | 8.21.0 | temporary, vendored scaffolding |
| `yaml` | 2.9.0 | temporary, vendored scaffolding |
| `ipaddr.js` | 2.2.0 | temporary, vendored scaffolding |
| `discord.js` | 14.26.4 | temporary, vendored scaffolding |
| `pdfjs-dist` | 5.4.394 | temporary, vendored scaffolding |
| `@redis/client` | 6.0.1 | temporary, vendored scaffolding |
| `@total-typescript/shoehorn` (dev) | 0.1.2 | donor tests |
| `tsup` (dev) | 8.5.1 | donor test `persistence/sessions/turn-records.test.ts` compiles the recovery worker |
| `@types/ws` (dev) | 8.18.1 | temporary, vendored scaffolding |

`@character-foundry/character-foundry` was not added (not allowed).

Overrides copied from the donor's `package.json`, only for packages that were
new to Lite's tree: `sharp` 0.35.5 (the transformers dependency; without it
npm resolved 0.34.5, which tried to build from source), `discord.js` and
`@discordjs/rest` `undici` 6.28.1, `adm-zip`, `basic-ftp`, `fast-uri`,
`fast-xml-builder`, `fast-xml-parser`, `global-agent`, `ip-address`, `lodash`,
`tar`. Plus **`vite` 7.3.7** for the whole repository, as in the donor: vitest
4.1.12 had resolved vite 8.3.6, whose oxc transform rejects two donor test
files that esbuild accepts (`core/agent/substrate-agent.test.ts`: a name both
imported as a type and declared; `faculties/memory/retrieval/access.test.ts`:
`readonly` on a non-array type). Lite's own suites pass on vite 7.3.7.
Donor overrides that would change packages Lite already had (`esbuild`,
`minimatch`, `picomatch`, `postcss`, `protobufjs`, `flatted`,
`@protobufjs/utf8`) were not applied.

## Lite-side amendments

- `tests/conformance/absence.test.ts`: the companion's classifier and logger
  packages (`@huggingface/*`, `onnxruntime-*`, `winston`) are allowed (operator
  ruling); the packages only the vendored scaffolding needs (`discord.js` and
  its `@discordjs/{builders,collection,formatters,rest,util,ws}`,
  `discord-api-types`, `@redis/client`, `pdfjs-dist`) are allowed in the
  manifest, the lockfile and `packages/companion` imports until the vendored
  scaffolding is cut; `packages/companion` is outside the name and path rule
  because the extracted tree keeps donor names verbatim (for example
  `SubstrateAgent`). Everything else the test bans stays banned
  (`@discordjs/voice`, `@character-foundry/*`, Redis clients other than the
  vendored one, and every name rule for Lite's own packages).
- Root `tsconfig.json` excludes `packages/companion`; it has its own
  `tsconfig.json` with the donor's compiler options (no
  `exactOptionalPropertyTypes`, `esModuleInterop` on, tests excluded from the
  typecheck as in the donor). Root eslint ignores `packages/companion/**`.
- Root `vitest.config.ts` runs two projects: `lite` (unchanged settings) and
  `companion` (`packages/companion/vitest.config.ts`).

## Measured size

Not measured yet: the tree still carries the vendored scaffolding. Measured at
the end of the extraction.
