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
| A path-preserving copy | Done: closure, selected tests, test-support and the temporarily vendored scaffolding (deleted in B7); typechecks with the donor compiler options; the extracted tests reproduce the baseline in a clean full run (Equivalence, below). |
| B1 seam cuts (3.7, 3.8, 3.13, 3.14, 3.16, 3.18) | Done (Seam cuts, below). |
| B2 seam cuts (3.4, 3.5, 3.6) | Done (Seam cuts, below). |
| B3 seam cuts (3.2, 3.3, 3.12, 3.15) | Done (Seam cuts, below). |
| B4 seam cut (3.9) | Done (Seam cuts, below). |
| B5 seam cuts (3.10, 3.17) | Done (Seam cuts, below): no core import of vendored scaffolding remains. |
| B6 seam cuts (3.1, 3.11) | Done (Seam cuts, below): the composition root boots over PostgreSQL (boot proof). |
| B7 delete the vendored scaffolding | Done (Seam cuts, below): every vendored scaffolding file is deleted, nothing in `packages/companion` imports, mocks or reads one, and the packages only scaffolding used are removed. |
| C swap Lite onto the extracted core | Done (Step C, below): `apps/standalone` wraps `startCompanionRuntime`, MCP serves the donor tool catalog, the lifecycle bridge and the Hermes plugin drive host-driven donor turns, `packages/pi` keeps only the model and embedding adapters, `packages/core` and `packages/adapters` are deleted, and conformance runs on donor behaviour. |
| Operator automata rules | Done (Operator automata rules, below): stable worker write keys; hosted automata as Hermes subagents. |
| Review fixes after Step D | Done (Review fixes after Step D, below): the model-usage recorder port, the promoted donor tests, exactly-once corrections, and the Step D records and provenance. |
| E operator rulings 2026-11-08/09 | Done (Step E, below): cut tool surfaces pruned from the registry, host-bound session integrity, host approval of memory deletion, the capability tier as an owner file (default `autonomous`), fatigue deferred, model usage in memory. |

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

**Promoted selection (added after Step D).** The colocated donor tests of
the promoted files (`extraction/vendored-files.txt` kind `promoted`) were
missing from the selection above. A test belongs to the promoted selection
when its sibling source file (the test path without `.test.ts` and any
trailing `.qualifier`) exists in `packages/companion` and no deleted or
excluded record names it. That gives 72 files, which are listed in
`extraction/tests.tsv` with selection `promoted`. They were run the same way
as above, in the same throwaway clone, with their own profile override and
`--maxWorkers=16`. Runs `promoted-a1` and `promoted-a2` each gave **72 files,
622 tests: 621 passed and 1 failed**. The failure is
`test-support/postgres-test-harness.test.ts` "forces disposable PostgreSQL
data into bounded RAM without swap or Docker logs". That test asserts the
harness's default profile label, so it fails under the isolation override.
That file alone without the override (it starts no container) passed all 14
of its tests (`promoted-harness-noenv`). `baseline.json` takes that file
from the no-override run and the other 71 from `promoted-a2`, and records
all three runs under `promoted_selection`. The baseline is now **807 files,
10,107 tests, all passed**.

## Extracted tree (Step A)

Copied byte-identical from the donor commit with `git archive` (verified
blob-by-blob; the single modified file is listed below):

| Part | Files | LOC |
|---|---:|---:|
| Closure (minus the card importer) | 1,095 | 318,894 |
| Selected tests (minus the card importer test) | 734 | 285,609 |
| Vendored scaffolding (temporary; deleted in B7) | 788 | 237,889 |
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
`operator/garden/services/types/sessions.ts`); both leave in B7. B3 edited
`core/agent/satellite-adapter-port.ts`, `core/agent/substrate-agent.ts`,
`substrate-agent/{channel-routing-runtime,prompt-context-builder,runtime-context,turn-execution-adapter}.ts`,
`substrate-agent/runtime-context-sections/reaction-surface.ts`,
`substrate-agent/turn-execution/{contracts,post-turn-scheduling}.ts`,
`core/artifacts/sensitivity-egress.ts`,
`core/icp/{agent-facing-autonomy,initiation-source-support,runtime-availability,speaking-precedence-resolver}.ts`,
`core/session/manager.ts`, `shared/event-bus.ts` and
`system/capabilities/gate.ts`. B4 edited
`core/scheduler/{free-time,quiet-hours-release-stagger,reflection-runtime-contracts,scheduler}.ts`
and `core/scheduler/post-turn-runtime/scheduler-lanes.ts`. Neither batch
touched a vendored file. The Step A0
closure lists (`closure-files.txt`, `closure-levels.tsv`, `closure-seams.tsv`,
`tests.tsv`) are the Step A record and are not pruned when a cut deletes a
file.

Donor test files are modified by deleting `it()` blocks (and a `describe()`
the deletions left empty, which vitest rejects), in two cases by removing
a cut-path assertion from a test whose subject is kept, and in one case
(B4) by removing fixture plumbing that only deleted tests used (Deleted and
modified tests, below).

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

Step B3 seam-group run (`--project companion`, after 3.2/3.3/3.12/3.15,
2026-11-08 23:14Z): exit 0, 733 files / 9,417 tests passed; comparison
`deleted: 2 files, 68 tests; matched: 9417`, equivalent. B3 deleted and
edited no test.

Step B4 seam-group run (`--project companion`, after 3.9, 23:19Z): exit 0,
733 files / 9,415 tests passed; `deleted: 2 files, 70 tests; matched: 9415`,
equivalent.

Step B3+B4 result (the plain validation command with a JSON reporter,
2026-11-08 23:23Z): exit 0, **785 files and 9,852 tests, all passed**
(`lite` 52 files / 437 tests, `companion` 733 files / 9,415 tests).
Comparison: `deleted: 2 files, 70 tests; matched: 9415`, `equivalent: every
remaining baseline test has its baseline status`. That is the baseline's
9,485 tests minus 70 deleted (7 card importer, 3 in B1, 58 in B2, 2 in B4).
The 2 edited B2 tests are among the 9,415 matched, and the B4 fixture edit
touches no test case. No `lite-companion-*` containers and no `/tmp/lc-*`
directories were left.

Step B5 seam-group runs (`--project companion`): B5a before its test
deletions: `deleted: 2 files, 70 tests; matched: 9415`, equivalent (the
deleted fleet-auth and skills tests still passed on the vendored files); B5b:
718 files / 8,845 tests passed, `deleted: 17 files, 640 tests; matched: 8845`;
B5c: 713 files / 8,802 tests passed, `deleted: 22 files, 683 tests; matched:
8802`. All equivalent.

Step B5 result (the plain validation command with a JSON reporter,
2026-11-09 00:18Z, after root tsc, companion tsc and eslint all exited 0):
exit 0, **763 files and 9,205 tests, all passed** (`lite` 52 files / 437
tests, `companion` 711 files / 8,768 tests). Comparison: `deleted: 24 files,
717 tests; matched: 8768`, `equivalent: every remaining baseline test has its
baseline status`. That is the baseline's 9,485 tests minus 717 deleted (70
before B5; B5a 52, B5b 518, B5c 43, B5d 34). The B5 fixture and import edits
are among the 8,768 matched. No `lite-companion-*` containers and no
`/tmp/lc-*` directories were left.

Step B6 result (the plain validation command with a JSON reporter,
2026-11-09 01:16Z, after root tsc, companion tsc and eslint all exited
0): exit 0, **764 files and 9,210 tests, all passed** (`lite` 52 files / 437
tests, `companion` 712 files / 8,773 tests). Comparison: `deleted: 24 files,
717 tests; matched: 8768; Lite additions: 1 files, 5 tests`, `equivalent:
every remaining baseline test has its baseline status`. B6 deleted and edited
no test; the one added file is the B6 boot proof. No `lite-companion-*`
containers and no `/tmp/lc-*` directories were left.

Step B7 seam-group run (`--project companion`, after the scaffolding was
deleted): 8,496 tests passed and one of 683 files failed to load:
`icp-fatigue-regulation-reservation.integration.test.ts` still imported the
deleted `icp-shared-autonomy-store.ts`. The first import scan matched single
quotes only and missed it. The file's subject is the fatigue reservation store
(scaffolding), so it is deleted, and the scan now matches both quote styles
and side-effect imports. Comparison: `deleted: 54 files, 994 tests; matched:
8491; Lite additions: 1 files, 5 tests`.

Step B7 result (the plain validation command with a JSON reporter,
2026-11-09 02:11Z, after root tsc, companion tsc and eslint all exited 0, with every
vendored scaffolding file deleted): exit 0, **734 files and 8,936 tests, all
passed** (`lite` 52 files / 440 tests, `companion` 682 files / 8,496 tests).
Comparison: `deleted: 54 files, 994 tests; matched: 8491; Lite additions: 1
files, 5 tests`, `equivalent: every remaining baseline test has its baseline
status`. That is the baseline's 9,485 tests minus 994 deleted (717 before B7,
277 in B7). The B7 edits (below) are among the 8,491 matched. No
`lite-companion-*` containers and no `/tmp/lc-*` directories were left.

Step C result (the plain validation command with a JSON reporter,
2026-11-09 03:52Z, after root tsc, companion tsc and eslint all exited 0):
exit 0, **693 files and 8,579 tests, all passed** (`lite` 11 files / 83
tests, `companion` 682 files / 8,496 tests). Comparison: `deleted: 54
files, 994 tests; matched: 8491; Lite additions: 1 files, 5 tests`,
`equivalent: every remaining baseline test has its baseline status`. That is
the same as B7. Step C deleted no donor test and edited none. The only change
was the boot test's import (Step C, below). The Hermes plugin suite
(`integrations/hermes/.venv`, Hermes `f0187332`) passed 50 of 50.

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
| `src/core/scheduler/post-turn-lanes.test.ts` "runs the companion sleeptime action under the fleet baton" and "runs episode synthesis under the fleet baton and checkpoints only after private progress" (2) | They assert the cross-companion maintenance lease protocol around the lane (`announceDemand`, `tryAcquire`, `commitCheckpoint`, `release`, the baton yield); the fleet coordinator, its runner and the `fleetMaintenance` runtime option are cut. The other two tests in the file (cadence never infers sleeptime; the task list, including the forwarded fleet stagger) still pass. | 3.9 fleet baton |
| B5a: `src/system/config/fleet-auth-config.test.ts` (44), `skills-per-companion.test.ts` (6), `subsystem-config.test.ts` "round-trips skills.json without drift" and "preserves skills positive integer validation wording" | Their subjects (`fleet-auth-config.ts`, `skills-config.ts`) are now `cut`. | 3.10 fleet auth, 3.17 skills |
| B5b: the 11 `src/core/agent/fatigue/*.test.ts` files (113), `turn-execution/icp-fatigue-regulation.test.ts` (1), `core/session/icp-recovery-fatigue-binding.test.ts` (345) | Their subjects are now `cut` (fatigue is types only). | 3.17 fatigue |
| B5b: `turn-execution-runtime.test.ts`, 27 in `fatigue enforcement` and the `human attention pressure` describe (1) | They assert budget spend, reservation, suppression, overcharge, the fatigue and boundary alerts and recovered pending spend; the runtime runs the donor no-port path. The 7 other `fatigue enforcement` tests still pass and stay. | 3.17 fatigue |
| B5b: `core/session/icp-delivery-recovery.test.ts` (31) | They assert parsing and binding of `fatigue` / `fatiguePendingSpend` in the recovery codec; those keys are now `excluded`. | 3.17 fatigue |
| B5c: `system/capabilities/runtime.test.ts` (4), `system/config/{capability-tier-config,capability-tier-per-companion,charge-policy-config,charge-policy-per-companion}.test.ts` (5, 8, 16, 6), `subsystem-config.test.ts` "round-trips capability-tier.json without drift" | Their subjects are now `cut` (charge and tiers are stubs). Step E4 brought back `capability-tier-config.ts` with its test and the round trip. | 3.17 charge, tiers |
| B5c: `core/agent/substrate-agent.test.ts`: "renders one atomic owner snapshot that agrees with self_status at the same turn boundary", "injected immutable custom access governs the capability seam over the disk runtime and tier defaults" | They assert the disk-backed `CapabilityRuntime` paths (`snapshotOwnerGrant`, precedence over the disk runtime), which are removed. The sibling "explicit custom access works without any disk-backed CapabilityRuntime" stays and passes. | 3.17 tiers |
| B5c: `core/agent/substrate-agent.test.ts` "uses the exact notify surface for candidates while ordinary turns retain the full catalog" | **Not a clean scaffolding deletion.** Its subject is ICP candidate control-plane reachability (a candidate turn exposes only `notify`, an ordinary turn keeps the full catalog, the handoff is queued without the permit id or reason). The substrate-agent half is kept core; the control plane (`app/agent/control-plane.ts`) is vendored scaffolding that B6 recomposes. The test grants the custom `external.companion` tier through a disk-backed `CapabilityRuntime` and asserts on its `has`, which the tier stub removes. No other baseline test covers the candidate notify-only surface. Recorded as an open question. | 3.17 tiers |
| B5d: `persistence/postgres/retired-fleet-grantees.test.ts` (6), `system/capabilities/shard-derivation.test.ts` (28) | Their subjects are now `cut` (closure recompute). | 3.10 recompute, 3.17 shards |
| B7 (whole files, 30 files / 183 tests): `persistence/postgres/{model-usage-budget,model-usage-certification,model-usage-store.benchmark,icp-conversation-cost-breaker}.integration.test.ts` (3, 1, 1, 5), `shared/telemetry/model-usage-certification-properties.test.ts` (4) | The model-usage ledger and budget store and the charge-cost reconciliation are vendored scaffolding (charge is a stub, B5c). | B7 charge |
| B7: `persistence/postgres/{fleet-system-observability,tenancy-boundary,named-tenant-store-boot,shared-schema-runtime-readiness,companion-presence}.integration.test.ts` (8, 5, 6, 6, 4), `persistence/system-owner-fleet-migration-evolution.test.ts` (13), `shared/observability/health-detectors/health-detectors.integration.test.ts` (4), `system/config/scheduler-per-companion.test.ts` (8) | Fleet tenancy, the shared world schema, the fleet migration, fleet health events and escalations, the runtime health detectors and the fleet owner-file layout are scaffolding. | B7 fleet |
| B7: `persistence/postgres/{icp-autonomy,icp-candidate-lifecycle-supervisor,icp-intention-lifecycle,icp-intention-retry-lifecycle,icp-admin-projection-cost-scope,icp-fatigue-regulation-reservation,social-pot-enforcement}.integration.test.ts` (20, 8, 2, 4, 3, 11, 8) | Peer-companion ICP initiation, the gateway autonomy broker, the Garden ICP projection, the fatigue reservation store and the social pot are scaffolding (fatigue is types only since B5b). | B7 ICP, fatigue |
| B7: `persistence/postgres/{egress-delivery-record,gateway-ingress-receipt}.integration.test.ts` (5, 3), `core/agent/substrate-agent/egress-tool-guard.test.ts` (2) | The custody snapshot and delivery record stores, the gateway CogSec receipt store and the real intake firewall are cut (seams 3.4 and 3.6). | B7 CogSec, custody |
| B7: `core/participation/{appraiser-injection,room-signal-candidate}.test.ts` (27, 5), `faculties/shards/manager-{capability-launch,configuration-snapshot}.test.ts` (9, 2), `core/identity/persona-owner-path-registry.test.ts` (4), `core/agent/{autoresearch-ttft,tool-schema-token-cost}.test.ts` (1, 1) | Their subjects are vendored scaffolding: participation (types only), the shard manager, the gateway persona path registry, the TTFT benchmark harness, and the token cost of the full donor tool catalog (17 of its 32 tools come from scaffolding factories). | B7 |
| B7 (94 tests in 31 files): CogSec intake firewall consumers: `core/session/intake-sink-gating.test.ts` (15), `manager-intake-screening.test.ts` (7), `context-builder.channel-bond.test.ts` (2), `faculties/memory/writer.test.ts` (3), `reflection-template-runtime/daily-review-evidence.test.ts` (1) | They assert a consumer's hold/withhold/audit behaviour under the real sink gate and screening service built from the intake-policy seed. The firewall is a stub (seam 3.4); Lite wires no gate, which is the donor's no-gate mode. The zero-string mutation check (rejected before any gate runs) is kept as an edited test. | B7 CogSec |
| B7: Garden (operator) services: `core/contacts/contact-tracking-approval-flow.test.ts` (3), `contact-archive.integration.test.ts` (1), `postgres-adapter.integration.test.ts` graph proposal (1), `biographical/cross-channel-conformance.integration.test.ts` (1), `turn-record-slimming.test.ts` Loom read path (1), `persistence/ledger-bounded-hydration.test.ts` fatigue / human-attention / charge ledgers (4) | The subject is the operator Garden service or ledger, which is scaffolding; the core stores they call stay covered by the other tests in each file. | B7 Garden |
| B7: backup, restore and repair: `contact-lifecycle-ledger.integration.test.ts` restore quarantine (1), `automata/bus/postgres-store.integration.test.ts` backup roles and tenancy grants (2), `biographical/postgres-store.integration.test.ts` backup (1), `memory/postgres-store.integration.test.ts` reattribution repair (1) | The backup service, the restore quarantine, the tenancy planner and the operator repair tool are scaffolding (Lite's continuity backup is its own, conformance scenario 09). | B7 backups |
| B7: gateway and settings layer: `primitives/llm/client.test.ts` (7), `system/capabilities/gate.test.ts` hook registry (3), `system/config/subsystem-config.test.ts` models.json and providers.json (10), `owner-file-modes.test.ts` (8), `owner-file-contract-adaptation.test.ts` (5), `decision-backend-config.test.ts` (3), `biographical-{candidate,depth}-policy.test.ts` (1, 1), `persistence/postgres/runtime-readiness.test.ts` entrypoints (1), `core/scheduler/health-detector-task.test.ts` (1) | They drive the gateway JSON-RPC transport, cost capture, hook registry and fleet eligibility, or the vendored settings.json / owner-file / models.json / providers.json layers, or the gateway and operator entrypoints. The host supplies the config, model registry and provider runtime (B5d, B6). The kept tests in each file (normalisers, defaults, `canonicalOwnerFileMode`, the gate's own hook path, `providerCostResolver`, the watchdog task) still pass. | B7 gateway, settings |
| B7: wiki, shards, fatigue, arbiter, custody: `situated-presence.test.ts` (1), `retrieval-cache.test.ts` shared memory / wiki embedding (1), `gate.test.ts` shard transport (1), `observed-machine-intelligence.test.ts` fatigue class (1), `speaking-precedence-resolver.test.ts` reservation phase (4), `turn-records.test.ts` custody snapshot parity (1), `schema-tenancy.integration.test.ts` shared world schema (1) | Their subjects (wiki retrieval, shard transport, fatigue class, the arbiter reservation phase, the CogSec custody snapshot builder, the shared world schema) are scaffolding; the resolver's signal matrix and fail-closed tests stay. | B7 |

Edited (`modified-tests.tsv`): `turn-execution-runtime.test.ts` "moves system
context into the prompt system lane instead of assistant history in
observability snapshots" and "appends the current datetime anchor at the end
of the provider system prompt". Each spliced the canary block into its
expected system prompt; only that element (and, in the first, the canary
`toMatch` line) is removed. The donor always armed a canary, so the expected
prompt now equals the donor's `assembleTurnPrompt` output with `canaryToken`
undefined (`prompt-assembly.ts:537`), not any donor runtime configuration.

Fixture edit (B4, `modified-tests.tsv`): in `post-turn-lanes.test.ts` the
`wireLanes` helper lost its `options` parameter (`{ fleetMaintenance? }`) and
the spread that passed it into the runtime options. Only the two deleted
baton tests passed it, and the runtime option no longer exists. The two
remaining tests call `wireLanes()` with no argument, as before; no assertion
changed.

Fixture edits (B5b, `modified-tests.tsv`): four `icp-delivery-recovery.test.ts`
tests ("rejects a fatigue-suppressed recovery response with visible content" /
"with an attachment", "rejects prepared status with a suppressed response",
"rejects suppressed status with an allowed response") and the `suppressed` row
of `icp-delivery-projection-store.test.ts` "projects getEntriesBefore through
%s delivery state". Each fixture lost only its `fatigue` (and, for
`recoveryWithFatigue()`, `fatiguePendingSpend`) metadata, which the codec now
rejects before the check under test. The checks they assert (a `suppress`
fatigue decision or `suppressed` status cannot carry a deliverable response;
status must match the decision; projection order) are kept core code, and every
assertion is unchanged.

Import-only edits (B5c): `moa-turn.test.ts` and `turn-execution-runtime.test.ts`
import `ChargePolicyConfig` from the contract it was re-exported from;
`substrate-agent.test.ts` and `subsystem-config.test.ts` lost the imports only
their deleted tests used.

Edits (B7, 78 rows in `modified-tests.tsv`, 61 files). About 56 rows only
remove an import or helper that only deleted tests used, or redirect an import
to the core copy of the same symbol (the promoted CogSec decision and contract
files, `shared/contracts/*` copies, `inner-life-config.ts`, the Lite
credential-vault fake). 22 change a fixture or a test body, each without
touching an assertion of the subject under test:

- Fixtures of the port type instead of a scaffolding builder:
  `substrate-agent.test.ts` builds the injected `CapabilityAccess` (tier
  `custom`, `identity.read`, `shard.spawn`, `world.read`) by hand instead of
  `deriveShardCapabilityGrant`, uses the donor `DEFAULT_SKILL_REUSE_CONFIG`
  values as a literal and drops the `lifecycleKubernetes` config field;
  `intake-sink-gating.test.ts` "rejects a zero-string mutation before gate
  evaluation" gets a hand-built gate of the port type (no string is screened);
  `turn-execution-runtime.test.ts` gets an inert fatigue harness (the runtime
  has no fatigue port since B5b) and the console message literal that
  `createInteractiveTerminalMessage` returned; the introspection store's
  `makeTurnRecord` uses the message literal `buildSubstrateMessage` returned;
  `owner-file-modes.test.ts` uses the donor file name `'fleet-auth.json'`.
- Reads through a kept path instead of an operator service:
  `concern-resolution-arc.test.ts` reads arcs with `journal.listConcernArcs`
  (same concern id and provenance) instead of the Garden concern service.
- Scaffolding tails removed from a kept test (the tail's expects go with it):
  the Garden Loom tail of the turn-record slimming round trip, the
  backup/restore tail of the biographical restart test, the Garden contact
  linker tail of the external memory service test, the custody-chain reader
  block of the memory consent test, the Garden health accumulator tail of the
  background-work live drain, and the notify-companion candidate tail of the
  schema-tenancy lineage test.
- Source-reading tests: the tool catalog support file builds the 15 kept
  factories and exports `SCAFFOLDING_HOSTED_TOOL_SURFACES` (the 17 registry
  surfaces whose factories were scaffolding: fs, repo, shell, web, mcp, world,
  analysis_workbench, self_status, system, skill, wiki, beads, notify,
  generate_image, selfie_create, publication, vault).
  `factory-descriptions.test.ts` now checks that the factories equal the
  registry minus that set, and that each excluded name is a registry surface.
  `automata-certification.test.ts` asserts that the `shard.long_horizon`
  adapter module (the deleted shard manager) is absent
  (`DELETED_SCAFFOLDING_ADAPTER_CLASSES`) and reads every other adapter as
  before. `runtime-readiness.test.ts` and `selfhood-charge-boundary.test.ts`
  read only the kept source files of their lists.

Not clean, recorded as open questions: the per-lane success-rate expects of
the live drain test and the Loom-view equality of the slimming test leave with
their Garden subjects; the kept core paths in those tests are unchanged.

### Promoted selection (after Step D)

The 72 promoted test files (Test baseline, above) were copied from the
donor unchanged. Then only the recorded edits were applied. The rows are in
`deleted-tests.tsv` and `modified-tests.tsv`, after the B7 rows. Of the 72
files, 54 are byte-identical to the donor, 17 are edited and 1 is deleted.

Deleted (37 tests):

| Test | Reason | Seam |
|---|---|---|
| `app/agent/scheduler-runtime.fleet-auth.test.ts` (whole file, 2) | Its subject is the agent database backup lane (`registerAgentDatabaseBackupLane`) and its hand-off to fleet auth; the backup lane, backups and fleet auth are cut. | 3.11 scheduler-runtime, fleet |
| `app/agent/scheduler-runtime.test.ts` (3): "cancels a biography stage that never won the fleet baton", the two shared-world caretaker tests | They assert the fleet maintenance baton and the shared-world wiki caretaker operation; both are cut. | 3.11 scheduler-runtime |
| `persistence/runtime-factory.test.ts` (2): the one-entry fleet tenancy test and the multi-companion fleet maintenance coordinator test | Fleet tenancy, the shared schema and the coordinator are cut. | 3.11 runtime-factory |
| `app/agent/startup-continuity.test.ts` "is awaited by the agent entrypoint", `core/letters/memory-extraction.test.ts` "is wired from the real agent runtime composition" (2) | Source-text tests of donor `app/agent/main.ts`, which is not extracted. The seam 3.11 composition root `companion-runtime.ts` replaces it. | 3.11 composition root |
| `core/cogsec/memory-candidacy.test.ts` (9) | They assert the cut candidacy classes: C persona review, D policy pattern, E executable and obfuscation patterns, the CogSec notice allow and rejections, and the local heuristics behind an allowing gate. These are the same classes B2 deleted for the other consumers. | 3.5 candidacy |
| `app/startup/composition/parity.test.ts` (2): `wireSettingsRuntime` registers the system tool, `wireFilesystemToolsRuntime` registers fs | The lifecycle system tool and the fs tool are cut. | 3.11 parity |
| `app/startup/support/operator-alerts.test.ts` `model budget threshold alerts` (5) | The model-budget threshold alert handler and its durable claim store are cut with the model-usage ledger. | 3.11 operator-alerts |
| `core/doing-mirror/sources.test.ts` (3 wishlist tests) | The wiki wishlist doing-mirror source is cut with the wiki. | 3.11 doing-mirror sources |
| `core/agent/companion-availability.test.ts` "retries a failed protected observation while live observation failures remain non-blocking" | The test drives the queue through the gateway Discord message handlers and satellite routing, which are cut. | gateway, channels (operator ruling) |
| `app/startup/composition/post-turn-actions.test.ts` "executes restored companion outreach through the real handler" | The deferred peer-companion outreach handler (`core/tools/notify-companion-handoff.ts`) is cut. | B7; ICP peer-target routing (operator ruling) |
| `app/startup/composition/composition.test.ts` (7 of 8) | They assert the analysis workbench REPL helpers, shell and code execution over the sandbox, gateway paged reads and the startup module loader. All of these are cut. | 3.11 composition |

Edited (10 tests; no kept assertion changed):

- `scheduler-runtime.test.ts` (4): the reads of donor `main.ts` and
  `core-runtime.ts` and the expectations on their text are removed (not
  extracted; the composition root replaces them). In the biography
  synthesis test, the fleet baton option and its `['continue']` checkpoint
  expectation are also removed, because Lite runs the donor no-coordinator
  branch.
- `runtime-factory.test.ts` (2): 8 keys of cut stores are removed from the
  expected runtime object, and so is the schema-pin expectation of the cut
  enrollment store's pool.
- `startup-continuity.test.ts` "completes both continuity warmups": the wiki
  context refresh expectation is removed (wiki hydration is cut; the two
  kept warmups are still asserted).
- `background-work-store.integration.test.ts` "projects a completed
  production turn through real extraction into Garden detail": the operator
  Garden tail is removed. The production turn, the TurnRecord deltas and
  every durable job assertion are kept.
- `icp-felt-impulse-funnel-store.integration.test.ts` "preserves
  exactly-once content-free outcomes and candidate lifecycle across
  restart": the peer initiation candidate store, its fixtures and the
  candidate projection assertions are removed. The funnel outcomes and their
  exactly-once checks across the restart are kept. This is not a clean
  deletion: the candidate lifecycle half of the test leaves with its
  subject (open questions).
- `composition.test.ts` "registers subagent as the only canonical
  bounded-worker surface": the helper calls `wireSubagentRuntime`, the seam
  3.11 cut of `wireShardAndThinkRuntime`, instead of the cut function. Its
  three expects are byte-identical.

File-level rows (15) cover imports, mocks and helpers that only deleted
tests used. They also cover redirects to the core copy of the same symbol:
`inner-life-config.js` for `loadAutomataPolicySeedDefaults`, the promoted
disclosure `decision.js` and `contracts.js` for the deleted barrel,
`shared/contracts/intake-sink-gate-port.js`, `notification-port.js` and
`personal-projects-port.js`. They also record the removal of the
`runtime-factory.test.ts` `vi.mock` blocks of 9 cut modules. One row is
test infrastructure: `test-support/postgres-test-harness.test.ts` gets a
`vi.hoisted` block that clears `PSFN_POSTGRES_TEST_PROFILE_OVERRIDE` before
the harness module loads, and an `afterAll` that restores it. Lite's
per-run isolation sets that override for the whole run (vitest global
setup), and the test asserts the default profile label, so the test sees
the same environment it had in the donor's own run. No assertion changed.

## Seam cuts

Every cut has a row in `packages/companion/extraction/cuts.tsv` (seam, site
file:line, cut type, detail, behaviour change). `node
packages/companion/extraction/remaining-seams.mjs [--summary]` lists the core
tree's remaining imports of vendored scaffolding; it is empty since Step B7.
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

The promoted files' colocated donor tests were not in the Step A0 selection
at first (a review finding after Step D). They are now the `promoted`
selection: 72 files and 622 tests, with their own donor baseline. 37 of the
tests (one whole file of 2 and 35 single tests) are deleted as tests of cut
scaffolding. 10 tests are edited, and 15 file-level rows record import, mock,
helper or setup changes, in 17 files in all. The other 585 tests run in Lite
and pass. See "Review fixes after Step D".

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

### B3 (3.2, 3.3, 3.12, 3.15)

Remaining seam statements: 65 before, 46 after 3.2/3.3/3.12, 34 after 3.15.
No remaining seam targets `boundary/gateway`, `channels` or
`core/agent/arbiter`.

Every new file is a verbatim copy (cut type **move verbatim** or **type
copy**), checked block by block against the donor git objects; its header
names the donor file and lines. Nothing is promoted: plan Step B7 requires
0 imports into the plan's scaffolding set, which includes
`src/boundary/gateway/**` and `src/channels/**`, so no file stays at a
gateway or channel path. The vendored originals stay (the vendored notify
tool, channel plugins and adapters still import them) and leave in B7.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.2 notifications | Move verbatim into `shared/contracts/notification-port.ts`: `boundary/gateway/notification-sender.ts` (whole file), `NotifyNtfyParams` and `NotifyNtfyResult` (`protocol.ts:703-711,1109-1113`), `NotificationPort`. 4 core sites redirected. | none. `artifactApprovalNotifier` is optional and defaults to null, the donor's no-notifier path; a host wires delivery. Unchanged from the donor: sharing a sensitive artifact with a non-self audience throws without an approval queue and a notifier (`sensitivity-egress.ts:167-169`). |
| 3.3 pre-tool hook | `boundary/gateway/pre-tool-hook.ts` moved whole to `system/capabilities/pre-tool-hook.ts` (only its config import path changes). | none, and no allow-all stub is needed: `gate.ts:336` (`getPreToolHookGate?.() ?? null`) and the agent's `preToolHookGate = null` (donor `substrate-agent.ts:387`) are the donor's no-hook path. A host with decision hooks passes a gate built with `createPreToolHookGate`. |
| 3.12 channels | Type copies: `shared/contracts/channel-prompt-port.ts` (`MessageHandlerOptions`, `ChannelChatType`, `ChannelCapabilities`, `ChannelPromptAdapter`, `ChannelPromptDock`, `ChannelPromptRegistryPort`) and `shared/contracts/api-health.ts` (`channels/api/types.ts:161-199`). Move verbatim: `channels/shared/reaction-surface.ts` to `shared/contracts/reaction-surface.ts`. Inline constant: `TESTING_HARNESS_API_PRINCIPAL_ID = 'testing-harness'` in `core/session/manager.ts` (donor `channels/backplane/http/auth.ts:8`). Delete call path: the companion-relay artifact announcement in `post-turn-scheduling.ts`. Delete unused declarations: `SatelliteChannelAdapterPort` and the `SatelliteAdapterPort.channel` facet. | none. The agent's channel registry defaults to an empty `Map` (donor `substrate-agent.ts:367`), so every turn takes the dock-less path and the reaction-surface block renders nothing. The announcement branch ran only for a non-empty attachment list, and since the 3.13 stub that list is always empty. Nothing in the donor tree references the removed satellite declarations. `handleMessage` keeps its `MessageHandlerOptions` parameter unchanged for the host adapters (Step C). |
| 3.15 ICP | Type copies: `shared/contracts/icp-gateway-contract.ts` (the ICP broker result shapes, `icp-autonomy-contract.ts:29-88,113-138,154-163`, including the three type-position `import()` sites) and `shared/contracts/speaking-arbiter-types.ts` (the arbiter's string unions and the `IcpSocialPrecedenceResolver` port, `core/agent/arbiter/{reservation-phase,egress-lease-phase,speaking-arbiter-store-port}.ts`), used by `core/icp/speaking-precedence-resolver.ts` and by the event-bus event types. `createAgentFacingIcpAutonomyRuntime` takes `gateway: IcpAgentGatewayPort`; the `GatewayClient` arm of the union is dropped (the vendored composition root still passes its `GatewayClient`, which satisfies the port structurally; the package typecheck passes). | none. See "Peer-target routing is unsupported" below. The speaking arbiter is not composed in Lite, so its events are never emitted; the event contract is unchanged. |

**Peer-target routing is unsupported (operator ruling), through the donor's
own no-broker mode.** The ICP broker (permits, dyads, peer availability) is
the donor gateway. The donor composes the agent-facing ICP runtime only when
`config.multiCompanion === true` (`app/agent/core-runtime.ts:426-432`), and
the source runtime with its weighted-thought and intention adapters only when
ICP autonomy is enabled (`app/agent/icp-initiation-source-wiring.ts:76-110`).
In that mode, read from the code:

- `self_status` availability actions answer `unavailable: ICP availability
  runtime is not wired` (`core/tools/self-status.ts:636-638`);
- the contact tools' peer availability is optional and skipped
  (`core/contacts/tools.ts:587`);
- social desire's human delivery policy refuses a companion target
  (`core/intention/social-desire-human-policy.ts:34-35`,
  `social_desire_human_target_is_companion`);
- weighted thoughts skip the ICP branch (`weighted-thought-outreach.ts:288`,
  guarded by `deps.icpCandidateAdapter`) and take the human lane, as in the
  donor's single-companion mode;
- the companion handoff is reached only from the notify tool
  (`core/tools/ntfy.ts`), which is outside the closure;
- the donor installs a fail-closed felt-impulse consumer that records
  `not_authorized` (`icp-initiation-source-wiring.ts`, disabled branch).

B3 therefore cuts types only. **For B6:** compose exactly that mode. Do not
compose the agent-facing runtime, the source runtime or their adapters, and
do not write a placeholder broker. Wire the disabled felt-impulse consumer
the way the donor does. (B6 correction: donor `main.ts:1118-1123` always
passes `handleFeltImpulse`, so the donor's own path takes the first branch of
`wireIcpInitiationSources` and the fail-closed consumer is never installed
there; B6 composes that, see B6.) `self-availability.ts:69` and
`notify-companion-handoff.ts:340,492,600` take the runtime as a required
argument, so nothing may call them without one.

**Notify and clarify tools.** `core/tools/ntfy.ts` (the HTTP ntfy notifier,
`notify` and `clarify` tools, the gateway notification port) is vendored
scaffolding outside the Step A0 closure, so the extracted core has no
notify tool. Whether a host adapter supplies one is a B6/Step C decision.

**For B7:** the B2 `promoted` files at `core/cogsec/*` sit inside the plan's
scaffolding set (`src/core/cogsec/**`). They are exempt only by the
operator's KEEP of `assessDisclosure`, the SOFT contact block list and the
memory-candidacy fallback exclusion. `remaining-seams.mjs` trusts the
`promoted` kind, so B7 has to state that exemption explicitly when it checks
"0 imports into the scaffolding set".

### B4 (3.9)

Remaining seam statements: 34 before, 28 after. No remaining seam targets
`core/scheduler/fleet-maintenance-*`.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.9 fleet stagger | Move verbatim: `staggerFleetOrdinalWithinWindow` and its local `requireTimestamp` (`fleet-maintenance-coordinator.ts:20-25,342-363`) into `core/scheduler/fleet-stagger.ts`. 3 sites redirected (`scheduler.ts`, `free-time.ts`, `quiet-hours-release-stagger.ts`). | none. |
| 3.9 fleet baton | Delete call path: the `ReflectionRuntimeOptions.fleetMaintenance` option (coordinator, lease and retry durations) and both `runWithFleetMaintenanceBaton` branches in `scheduler-lanes.ts` (sleeptime, episode synthesis). | none for a host without a fleet coordinator: this is the donor's path when the option is absent (the plan's "immediate baton"). Sleeptime runs at once, and a sleeptime yield reschedules after the rest-window inactivity threshold. An episode-synthesis yield throws the donor's `Episode synthesis cannot yield without fleet maintenance authority`. A host can no longer serialize heavy maintenance across companions. 2 tests deleted, 1 fixture helper edited. |

**Why the stagger is moved, not stubbed to zero.** The plan said "stub to a
zero stagger". The arithmetic is the scheduler's own wall-clock stagger.
`FleetSlotStagger` is a closure type (`core/scheduler/types.ts`), set from
scheduler.json `fleetStagger`. Baseline tests assert the stagger with
`fleetSize > 1`: `scheduler.test.ts:244-309`, `free-time.test.ts:418-431`,
`temporal-wakeup.test.ts:487` and `post-turn-lanes.test.ts:155,230-254` (donor line numbers). They
test the scheduler, not the fleet lease, so a zero stub would break them and
could not delete them under the equivalence rule. Only the pure function
moves. The lease coordinator, the runner and the Postgres lease store stay
vendored and leave in B7.

**Plan 7.7, "stagger(ordinal 0 of 1) = 0", is now verified from the code.**
The function returns
`windowStartMs + floor((windowEndMs - windowStartMs) * manifestOrdinal / fleetSize)`,
which is `windowStartMs` for ordinal 0 of 1. Every caller also skips it when
no stagger is passed (`scheduler.ts:173,209`, `free-time.ts:992`,
`quiet-hours-release-stagger.ts:50`).

**For B6** (done, see B6: the shared-schema chain is never applied by a Lite
boot): donor migration 18 (`fleet-maintenance-process-fencing`) creates
the lease tables. `migrations.test.ts:416` and two Postgres integration tests
(`companion-presence`, `schema-tenancy`) assert it in the chain, so it was not
touched here. It belongs to the migration-chain cut (3.11). The vendored
composition root (`app/agent/scheduler-runtime.ts`, a source-text fixture)
still passes `fleetMaintenance`. It is not compiled and leaves in B6/B7.

### B5 (3.10, 3.17)

Four sub-batches, each with its own `--project companion` run, comparison,
commit and push: B5a (wiki, skills, shards, introspection; config fields),
B5b (fatigue and participation), B5c (charge and capability tiers), B5d (the
inner-life config loader and the closure recompute). Remaining seam
statements: 28 before, **0 after** (`remaining-seams.mjs --summary`: `0
statements into 0 scaffolding files`).

**New record kind `cut`** (`vendored-files.txt`): a Step A0 closure file that
a B5 cut moved out of the core, because an operator ruling made it scaffolding
or because no core file imports it any more. It stays unchanged at its donor
path, no longer counts as core in `remaining-seams.mjs` (which treats it as
scaffolding) and leaves with the vendored scaffolding in B7. A donor test
whose subject became `cut` is deleted in the batch that cuts it. 26 files /
8,339 LOC are now `cut`; core (closure minus `cut`, plus promoted and Lite
files, non-test `.ts` and imported `.json`) went from 1,122 files / 322,389
LOC before B5 to 1,110 files / 314,881 LOC.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.17 shards | Promote `faculties/shards/{lineage-contracts,artifact-policy,artifact-return-port,types,output-review}.ts` (byte-identical), with `fold-review.ts` and `result-lineage.ts` already seeds. Move verbatim: `truncateShardContextText` (`context-pack.ts:382-388`) into `faculties/shards/context-text.ts`; `output-review.ts:17` imports it from there. | none. |
| 3.17 wiki | Type copy `WikiRetrievalContextClass`, `WikiRefreshStatus`, `WikiContextSnapshot` (`active-context.ts:4-39`) into `shared/contracts/wiki-context.ts`. Stub: `faculties/memory/sleeptime-wiki-stage.ts` copies the wiki-pass input/result types (`sleeptime-wiki-pass.ts:146-189`) and adds `createDisabledSleeptimeWikiPass()`, which returns the empty result with `skippedReason: 'disabled'`. Move verbatim: the project-entity helpers (`personal-project-contracts.ts:9,128-141`) into `core/scheduler/project-entity-id.ts`. | The turn's wiki block is empty (the donor's unwired-retrieval path). The sleeptime stage order keeps `wiki_pass`, but the stage does nothing, as in the donor with `sleeptime.wikiPass.enabled` false. The free-time workspace resolver is unchanged. |
| 3.17 skills | Type copy `TurnToolSummary` (`reflection-nudge.ts:45-60`) and an empty `SkillsRuntime` port into `shared/contracts/skills-runtime-port.ts`. Delete call path: the `ReflectionNudgeTracker` and the skills-config import in `substrate-agent.ts`; `evaluateReflectionNudge` is `() => null`. `skills-config.ts` is `cut`. | none for Lite (no skills runtime): the skills index is empty and the nudge step is skipped, as in the donor with `skillsRuntime` null. A host that wires a skills runtime gets the index but no reuse or revision nudge. |
| 3.17 introspection, EmoSim/ICP, biography, social graph | Operator KEEP; none needed (all Step A0 seeds). Introspection keeps its donor default: audit off (`scheduler-config/introspection.ts:22-23`, seed `introspectionAudit.enabled: false`). | none. |
| 3.17 fatigue / participation | Type copy only what `shared/event-bus.ts` and three core sites need: `shared/contracts/participation-types.ts` (`core/participation/types.ts:11-26,95-141,154-156,186-197`) and `shared/contracts/fatigue-event-types.ts` (`human-attention-pressure.ts:7-41`, `room-episode-circuit-breaker.ts:50-64,77-78,80-102`, `social-pot-enforcement.ts:54-62`). Delete call path: the fatigue ports (`fatigueBudget`, `humanAttentionPressure`, `fatigueRegulationReservations`), the evaluation, reservation, spend, finalize and release blocks in `turn-execution-runtime.ts`, and the two alerts in `prompt-assembly.ts`. Stub: the ICP recovery codec marks `fatigue` and `fatiguePendingSpend` `excluded`. 15 files `cut` (`core/agent/fatigue/*` in the closure, `icp-fatigue-regulation.ts`, `core/participation/types.ts`, `icp-recovery-fatigue-{binding,metadata}.ts`). Deferred, not dropped (Step E5). | A turn runs the donor's no-port path: no budget, no MI-turn suppression or overcharge, no `agent.fatigue` events, no fatigue or human-attention prompt alerts (both builders return `''` without their ports). A recorded ICP recovery response that carries fatigue metadata is rejected with `<label> contains unknown fields: fatigue, fatiguePendingSpend` (the donor parsed and bound it); Lite never records one. |
| 3.17 charge | Stub (inert mode): nothing in the core loads `charge-policy.json`, so `SubstrateConfig.chargePolicy` stays undefined and every core caller takes its donor no-policy branch (`substrate-agent.ts:1944`, `moa-turn.ts:213,432-433`, `run-charge.ts:376-378,443-447,520-523`, `runtime-context-sections/charge.ts:61-69`). `run-charge.ts`, the `charge-policy.ts` contract and the charge prompt section stay core, unchanged. Redirect the three type imports to the contract; delete call path: the durable charge recorder/probe (their only reader was `icp-fatigue-regulation.ts`). `charge-policy-config.ts` is `cut`. | No run-charge quotas, no `Charge quota exceeded` errors, no `agent.charge` events; the charge prompt variables report no budget. The donor seed set quotas per lane (interactive 24, companion_social 24, background 16, maintenance 0, subagent 6, shard 12). A host that sets `config.chargePolicy` itself still gets the donor behaviour. |
| 3.17 capability tiers | Delete call path: `CapabilityRuntime` (the per-refresh `capability-tier.json` reader) and `setCapabilityRuntime` in `substrate-agent.ts`. `tier-types.ts` and `tiers.ts` stay core; the tier comes from an injected `CapabilityAccess` or `config.capabilityTier` via `normalizeCapabilityTier`, fallback `nursery` (`tiers.ts:88-93`), the donor seed's tier (`capability-tier.seed.json`: `{"tier": "nursery", "customTokens": []}`). `system/capabilities/runtime.ts` and `capability-tier-config.ts` are `cut`. Amended by Step E4: `capability-tier-config.ts` and the seed are back, and the tier is the owner file, read at start. | The tier is fixed by the host; owner edits to `capability-tier.json` (and its `custom` token list) are no longer read. Since E4: read at start, default `autonomous`. |
| 3.10 config contract | Type copy into a vendored module augmentation: 83 `SubstrateConfig` fields of cut subsystems (gateway, fleet auth, CogSec screening, kube lifecycle, wiki hydration, shards/satellites/Wyoming, document ingest, images, voice, Discord triggers/Telegram, Garden theme, analysis workbench, web fetch / Home Assistant / Obsidian) and 5 declarations leave `runtime-config-contracts.ts` for `system/config/scaffolding-config-fields.ts` (`declare module './runtime-config-contracts.js'`). None of the 83 has a core reader (1,128 core files scanned). `discordToken` and `discordBotId` stay (`extraction.ts:849` reads `discordBotId`). Inline `FLEET_AUTH_FILE_NAME` in `owner-file-modes.ts`; the 3 fleet-auth config files are `cut`. | none. |
| 3.10 loader | Port: `system/config/inner-life-config.ts` (Lite file). `loadInnerLifeConfig({ dataDir, companionDataDir?, seedDir?, modelRegistry? })` loads `scheduler.json`, `trust-policy.json`, `subagent-roles.json` (`subagent-roles-config.ts` promoted) and `automata-policy.json` through the donor loaders, and from `settings.json` the 8 inner-life policy keys through their closure normalisers with the donor defaults; `compositionalPolicy`, `observerEvalSidecar` and `emosimProactivity` take the load-config defaults. The automata loader, reviewer-model check and `listEnabledModelRegistrySlotKeys` are copied verbatim except that the registry comes from the host, not `models.json`. | Other `settings.json` keys are ignored; an override of the 3 default-only keys is ignored; the reviewer check needs a host registry and fails closed with the donor message without one. |
| 3.10 closure recompute | Reachability from the Step A0 seeds over the current core imports (all import kinds, fixpoint). Newly unreachable, now `cut`: `persistence/postgres/retired-fleet-grantees.ts`, `shared/utils/postgres-credential.ts`, `shared/contracts/cogsec-persona-conformance.ts`, `system/capabilities/shard-derivation.ts`. Unreached but kept: the two forked session workers and the quarantine module (spawn edges, Step A0) and the new loader with `subagent-roles-config.ts` (B6 composes them). | none. |

**Loader equivalence probe.** With the shipped seeds copied in as owner files,
`loadInnerLifeConfig` (registry from the vendored `loadModelsConfig`) was
compared against the vendored donor pipeline (`createOwnerFileConfigStore`
loaders, `settings/io.ts` `loadSettings`, then the load-config default where
a key is absent): deep-equal for `scheduler.json`, `trust-policy.json`,
`subagent-roles.json`, `automata-policy.json` and all 11 settings values.
Without a registry it throws the donor message (`automata-policy.json.bus.reviewer.model references slot "gpt-5.4-nano", which is not an enabled models.json registry entry. ...`).
It ran as `npx tsx packages/companion/extraction/inner-life-loader-probe.mts`
(exit 0, one `equal` line per value). It was a probe, not a test: it compared
against vendored scaffolding, and a new test in the companion project is an
addition that `compare-baseline.mjs` rejects. B7 deleted it together with the
loaders it compared against, so it can no longer be rerun.

**Exemptions kept from earlier batches.** `faculties/shards/context-text.ts`
is a Lite file inside a scaffolding directory (the promoted `output-review.ts`
needs it). The B2 CogSec ports stay as recorded under B2.

**For B6:**
- The composition must pass `createDisabledSleeptimeWikiPass()` to the
  sleeptime agent: `SleeptimeMemoryAgent` requires every stage runner
  (`sleeptime-agent.ts:654`).
- A host-wired skills runtime would not restore the reflection nudge (its
  tracker is deleted, `evaluateReflectionNudge` is `() => null`).
- `loadInnerLifeConfig` covers the policy files only. The scalar
  `SubstrateConfig` tunables that `settings.json` also carries (extraction
  and profile-synthesis thresholds, compaction, budgets) are applied by the
  donor's `DIRECT_DEFINED_CONFIG_SETTINGS`; they belong to the B6 composition.
- The vendored `app/agent/startup/free-time-lane.ts` still passes
  `chargePolicy`; it is a source-text fixture and leaves in B6/B7. (B6: it is
  promoted and compiled; the root passes `config.chargePolicy`, undefined
  unless the host sets it.)

**For B7:**
- Deleting `system/config/scaffolding-config-fields.ts` is the compile proof
  that no vendored importer of the 83 cut fields survives.
- Tests that use a `cut` module only as a fixture still pass on the vendored
  copy and must be rewritten or deleted then: `primitives/llm/client.test.ts`
  (`new CapabilityRuntime`), `core/agent/substrate-agent.test.ts` and
  `faculties/shards/manager-capability-launch.test.ts`
  (`deriveShardCapabilityGrant`).

### B6 (3.1, 3.11)

Four commits: 3.1 (provider and embedding adapters), then 3.11 in three
parts: (a) promote the composition helpers, (b) the runtime-factory subset
and its stores, (c) the scheduler runtime, the lanes and the composition
root. Remaining seam statements: **0** after each part
(`remaining-seams.mjs --summary`). Every changed donor file is recorded in
`cuts.tsv` with its behaviour change; the donor files the root needs are `promoted`,
including `shutdown-helpers.ts`, the journal integration and the startup
lanes. The companion `tsconfig.json` no longer excludes
`scheduler-runtime.ts`, `free-time-lane.ts` and
`automata-background-work-lifecycle.ts`: they are core now, not source-text
fixtures.

| Seam | Cut | Behaviour change |
|---|---|---|
| 3.1 provider | `createProviderRuntimeServices` keeps the donor no-model-usage-store branch and takes an optional host `embeddingProvider`. (Amended after Step D, see "Review fixes after Step D": the host's `ModelUsageRecorder` now takes the store's slot.) Host adapters in `packages/pi`: `companionProviderRuntimeOf` (a structural `ProviderRuntime` over one `PiModelRuntime`), `companionModelRegistryEntryOf` (one `models.json` registry entry routing the donor's single-model purposes to the host model) and `companionEmbeddingProviderOf` (a donor `EmbeddingRuntimeProvider` over a Lite `EmbeddingPort`). The in-process `LLMProviderPort` is the donor's own `LLMClient`. | No model-usage ledger or embedding usage accounting. The host model and key serve every purpose. (Unrecorded at the time: every autonomous lane was refused; fixed after Step D.) |
| 3.11 composition helpers | `composition.ts` and `parity.ts` promoted and cut (rows in `cuts.tsv`): Redis session tail, CogSec integrity observers, fatigue options, operator hooks and the shard manager are cut. `wireShardAndThinkRuntime` became `wireSubagentRuntime`, which returns the subagent faculty and the fold-review controller. | See `cuts.tsv`. |
| 3.11 persistence | `createAgentPersistenceRuntime` keeps the donor single-companion path and the kept stores. It drops the fleet, health, escalation, CogSec receipt, custody, partner-affect, ICP-candidate, social-pot, arbiter and participation stores. | The scaffolding tables are never created (boot proof). |
| 3.11 scheduler runtime | `scheduler-runtime.ts` promoted and cut: the backup lane, health detectors, blind review, the shared-world caretaker, presence and fleet maintenance are cut. The gateway option becomes `llmProvider` + `embeddingDims`. | Those lanes are never scheduled. Biography stages run without a fleet baton. |
| 3.11 root | New `app/agent/companion-runtime.ts`, `startCompanionRuntime(options)`. It replays donor `main.ts`, `core-bootstrap.ts` and `core-runtime.ts` in order, with donor line citations per block. Lanes and helpers are promoted unchanged where possible. Cut, with a row each: the decision runtime's Jev backend, the model-budget alert, the wishlist doing-mirror source, the wiki startup hydration, the personal-project library (an empty `PersonalProjectsPort`), the optional ICP gateway and the optional memory-deletion approval port. | See below. |

**What the root does.** It follows the donor order:

1. Runs the whole boot under one `PostgresPoolOwner('agent')` (donor
   `main.ts:2539`).
2. Applies the inner-life owner files over the host config: the settings
   policy keys, `setRuntimeTrustPolicy`, subagent roles and the Automata
   policy (donor `bootstrap-helpers.ts:244,271-272,423-425`).
3. Builds the fixed `CapabilityAccess` from `config.capabilityTier`, then the
   eligibility gate and the persistence runtime. (Since Step E4 the access
   comes from the owner's `capability-tier.json`.)
4. Builds availability, contact approvals, the social graph stores and the
   tracking gate.
5. Runs identity, ML warm-up and emotion.
6. Builds the core runtime on `sanitizeCoreSubstrateConfig(config)` (donor
   `startup-context.ts:112`, `main.ts:700`): the Automata Bus, the observer
   sidecar, sessions, letters, retention, `SubstrateAgent`, the alerts, the
   prompt/card/settings/session tools, contacts, biography, intentions,
   introspection consent, core memory, concern arcs and memory.
7. Rehydrates startup continuity and internal state.
8. Builds the scheduler runtime.
9. Wires letter memory extraction, episode search and the ICP sources in the
   donor no-broker mode. It passes `handleFeltImpulse`, as the donor does, so
   the felt impulse reaches the social-impulse outreach runtime.
10. Registers the introspection lane, subagents with fold review, the memory
    writers and tools, the episode semantic index, episodic synthesis, sleep
    consolidation, arcs, dream meaning and the disabled sleeptime wiki pass.
11. Registers the journal tools, the long-horizon router, the outreach outbox
    and the proactive outbound. The outbound is built only with a host
    heartbeat channel.
12. Registers the temporal wake-up, free time, weighted thought, social
    desire, social impulse and EmoSim sampling lanes, and the reflection
    runtime.
13. Seals the PostgreSQL readiness, starts the scheduler and emits
    `system.init` / `system.ready`.

`stop()` runs the donor `control-plane.ts:226-288` sequence minus its cut
steps. It ends with the donor `closeDatabase` store list and
`postgresPoolOwner.close()`.

**Host ports.** All are optional except the config and the inner-life config:

- the provider runtime and embedding provider (3.1);
- the text emotion classifier (default: the donor transformers classifier);
- the operator notifier (default: log only);
- the outbound sender (default: refuses);
- the heartbeat channel;
- the availability projection (default `unsupported`);
- the session integrity provider (production session mode only with one);
- the continuity channel ids and prefixes;
- the contact-tracking channel labels;
- the memory-deletion approval port.

The host builds the `SubstrateConfig`. The donor's `load-config.ts` (env) and
`settings/runtime.ts` `applySettings` (the scalar `settings.json` tunables,
`DIRECT_DEFINED_CONFIG_SETTINGS`) are scaffolding: they carry every cut
subsystem's keys. Copying the scalar settings onto the config is therefore
host work. The boot proof does it from `settings.seed.json`.

**Migration chain.** No central chain runs. Each kept store applies its own
donor chain on connect, unchanged (the migration golden tests pin them). The
cut stores' chains are never applied: health/escalation, CogSec, custody,
partner affect, model usage, wiki projection, analysis workbench, and the
`shared` schema chain, including migration 18
`fleet-maintenance-process-fencing`. A kept chain still creates the few
tables the donor put in it for features that are now cut (for example
`icp_initiation_candidates` in the intention chain), exactly as the donor
did.

**Boot proof** (`src/app/agent/companion-runtime.boot.integration.test.ts`, a
Lite addition listed in `extraction/added-tests.tsv`). It boots over the
donor harness's pgvector PostgreSQL with:

- a pi-ai faux model through `companionProviderRuntimeOf` /
  `companionModelRegistryEntryOf`;
- deterministic 16-dimension vectors through `companionEmbeddingProviderOf`;
- a scripted text classifier;
- the shipped seeds as owner files, with the Automata reviewer pointed at the
  host model.

It asserts:

- `system.init` then `system.ready`;
- a `handleMessage` turn returns the scripted reply, with the card name in
  the system prompt;
- the started scheduler fires the heartbeat by itself (`schedule.healthcheck`
  with the task count, no manual tick);
- exactly 18 registered tasks. These are the donor's registrations for these
  seeds, minus the registrations the cuts removed: the backup tasks, the
  tool-usage evaluator, world exploration and the drift / second-arrow lanes
  (compared by registration call against donor `main.ts` and
  `scheduler-runtime.ts`). The introspection audit, weighted-thought outreach,
  blind review and EmoSim sampling are off in the seeds, as in the donor;
- the database holds only the `extensions` and `public` schemas, no table of
  a cut chain, and a sample of 17 kept-store tables.

`compare-baseline.mjs` now reads `added-tests.tsv`. A listed file is counted
apart from the baseline and every test in it must pass. An unlisted addition
still fails the comparison.

**Open after B6** (for the operator or Step C):

- **Contact-lifecycle recovery.** It runs only with a host
  `contactLifecycleGateway`. The root passes none, because the donor's port
  was the gateway.
- **Session integrity.** Without a host `sessionIntegrityProvider` the
  sessions run in the donor's non-production mode (no journal HMAC chain).
  (Step E2: the standalone host passes the donor keyring provider whenever
  `sessionIntegrity` is `keyring`, scoped per Hermes install.)
- **Continuity channels.** No continuity channel ids by default. The donor
  read them from `channels.json`.
- **Memory deletion.** Without a host approval port, the companion's memory
  delete action returns the donor's "not configured" error. (Step E3: the
  standalone host passes a port when the lifecycle bridge is configured, and
  Hermes's human approval gate decides.)
- **Observed group memory.** `ObservedGroupMemoryScheduler` gets no channel
  view, because no channel adapter publishes group-memory channels. It serves
  the reflection runtime as the memory scope classifier only.
- **Not composed.** The donor's external-memory (memory-deletion RPC)
  service, the gateway message handlers and the notify / clarify tools are
  not composed. A host calls `agentLoop.handleMessage` directly.

### B7 (delete the vendored scaffolding)

Every file of `vendored-files.txt` of kind `scaffolding` (732), `cut` (26) and
`source-text` (2) is deleted: 760 files, 230,765 LOC. 23 of them,
`src/persistence/backups/*`, were in the tree but never in Git, because the
repository's `.gitignore` ignores `backups/`; they are deleted from disk the
same way. Also deleted, because only deleted files read them (kinds
`test-support-deleted`, `asset-deleted` and `seed-deleted`): the
`lifecycle-kubernetes-settings.ts` test support; 23 assets (gateway goldens
and images, the CogSec intake corpus, file-ingest fixtures, fleet SSO fixtures,
`external-channel-limits.json`, and the donor timeout registry that was never
copied); `extraction/inner-life-loader-probe.mts` (it compared against the
deleted donor loaders, as planned under B5); and 11 seeds (backup,
capability-tier, charge-policy, fleet-auth, intake-l1-rules, mcp-servers,
models, partner-affect-shadow, places, providers, skills). The 8 seeds that
core loaders read stay. (Step E4 brought back the capability-tier seed.) The rows stay in `vendored-files.txt` as the record;
the absence test fails if one comes back.

Every reference was found with an import scan (both quote styles,
side-effect, dynamic, `vi.mock`) and a scan for string paths that resolve to
a deleted file. Then each kept file was handled in one of these ways: delete
a dead import; redirect to the core copy; build a fixture of the port type;
inline the literal a scaffolding helper returns; remove a scaffolding tail
from a test; or delete the test (Deleted and modified tests, above). Core code
changes (`cuts.tsv`, seam B7):

- `src/app/agent/companion-runtime.ts`: the primary user no longer falls back
  to `config.voiceTargetUserId`, and the root no longer registers the
  `'intake.screening.fail_closed'` alert handler. Both read fields typed only
  by the deleted `scaffolding-config-fields.ts` augmentation, and Lite emits
  no screening failure since seam 3.4. The handler stays in the promoted
  `operator-alerts.ts`, unused.
- `src/system/config/inner-life-config.ts`: `loadAutomataPolicySeedDefaults`,
  copied from donor `automata-policy-config.ts:31-39`, for six automata tests.
- `src/test-support/static-credential-vault.ts` (Lite, test only): the donor
  `createStaticCredentialVault` / `createEnvCredentialVault`
  (`boundary/custody/credential-vault.ts:94-119`), unchanged, over the
  credential contract.
- `src/persistence/redis-cache.ts` was scaffolding (no core importer) and is
  deleted with the rest.
- `packages/companion/tsconfig.json` no longer excludes the deleted
  gateway and operator entrypoints.

`remaining-seams.mjs` reports 0 statements. Four core files still name a
deleted path as data, not as a module reference: the consumer metadata in
`core/identity/persona-preamble-seeds.ts:146` and `prompt-registry.ts:276`
(`faculties/wiki/sleeptime-wiki-pass.ts`), the `shard.long_horizon`
`adapterModule` in `faculties/automata/bus/class-adapters.ts:94`
(`faculties/shards/manager.ts`, checked by the certification test above), and
comments in `shared/contracts/world-notes.ts:9` and
`system/config/companions-config.ts:33`. The core tool registry still lists
the 17 surfaces whose factories were scaffolding. These are open questions
for Step C, not imports. Step C left them as they are (below); Step E1
removed them (Step E, below).

## Step C: Lite over the extracted core

Step C replaced Lite's own companion core with the extracted donor core. The
Lite-side code that remains is host adapters around
`startCompanionRuntime` (see [architecture](architecture.md)):

- `apps/standalone` is a thin wrapper. It validates the Lite config
  document, builds the donor substrate config from the donor's load-config
  defaults plus the host's choices (`substrate-config.ts`), and loads the
  inner-life owner files with the donor loader. It then starts the companion
  with the Pi model runtime, the embedding port, the session keyring and an
  outbound sender, provisions the configured contacts, and mounts the MCP
  transport and the lifecycle bridge. The CLI keeps `init`, `once`, `chat`
  and `serve`.
- `packages/mcp` serves the donor tool catalog: one MCP tool per tool the
  `SubstrateAgent` registers, with the donor's name, description and TypeBox
  schema (`packages/lifecycle/src/tools.ts`). It holds no tool logic,
  validation or authorization. A call is handed with its credential's
  principal to the host tool port, and that port runs it as a model tool
  call of the principal's open host-driven turn, inside the donor loop.
- `packages/lifecycle` does host-driven turns. `prepare` calls
  `SubstrateAgent.handleMessage` on the donor's Hermes channel convention
  (`externalMemorySessionId`). The relay answers that turn's model calls
  from the host through the donor's stream transport seam (seam C below).
  `prepare` returns the first model call's context (system prompt, history
  with donor message classes, offered tools). A host tool call is answered
  to the donor loop as the model's tool call, and the donor's tool result
  comes back. `settle` with the host's final reply ends the donor loop, and
  the donor then archives the turn and runs its post-turn work.
  `checkpoint` looks each turn up in the donor's archive (`sessionManager.findUniqueSourceRecordedTurn`).
- `integrations/hermes` drives those turns from Hermes hooks.
- `packages/pi` keeps only the Pi model runtime, the embedding port and
  their result shape. The Lite Pi harness (companion harness, loop, context,
  tools, settlement, worker host, inference) is deleted, because the donor
  `SubstrateAgent` is the harness.
- `packages/core` (125 files) and `packages/adapters` (33 files), 19,618
  lines between them, are deleted. So are their tests and the Lite runtime
  benchmarks (`scripts/bench/inference.ts`, `latency.ts`, `lite-host.ts`).

### Seams and host choices

- **C: `wrapStreamTransport`** (`cuts.tsv`, seam C).
  `startCompanionRuntime` takes an optional function that receives the
  default in-process stream transport (`{ stream: llmProvider.stream }`, the
  `SubstrateAgent` default) and returns the transport the agent uses. In the
  donor, `core-runtime.ts:724-726` passed `gateway.stream` there, and that
  was the foreground turn's only model seam. Without the option, behaviour
  is unchanged.
- **Workspace, logs and temp.** The donor took `WORKSPACE_PATH` from the
  environment of its fleet startup (cut). Otherwise `persistence/layout.ts`
  falls back to `./workspace`, `./logs` and `./tmp` of the working directory
  (`:75-77`, `:243-260`). A first conformance run wrote a `workspace/` into
  the repository that way, and the journal of one run then showed another
  run's notes. Lite's config now requires `workspaceDir`, which must not be
  `dataDir`, sit inside it or contain it (the donor's own overlap rule,
  `layout.ts:146-155`). The runtime passes a `pathSnapshot`
  (`resolveRuntimePathSnapshotFromConfig`) with that workspace and with
  `<dataDir>/logs` and `<dataDir>/tmp`.
- **`CONFIG_DIR`.** The donor seed loaders read `process.env.CONFIG_DIR` and
  fall back to `./config` of the working directory (for example
  `system/config/companions-config.ts:646`,
  `core/identity/runtime-prompt-layers.ts:208`). The standalone sets it to
  the companion's shipped seeds when the process has none, and passes it in
  the runtime `env`.
- **Database.** The donor keeps pgvector in an `extensions` schema
  (`persistence/postgres/connection-options.ts`). Installs and test
  fixtures create that schema before `init` (`tests/support/lite-install.ts`).
- **Logger.** The donor logger writes to stdout. Processes that speak a
  protocol on stdout (the conformance host, the Hermes e2e host) keep the
  real `stdout.write` for protocol lines and send the rest to stderr.
- **One runtime per process.** The donor keeps process-wide state (the
  readiness ledger, among others), so every test or host that needs a fresh
  companion starts its own process (the conformance host process) or a
  fresh vitest fork.
- **The 17 registry surfaces whose factories were scaffolding** (the B7
  question above) stay in the donor registry text. No factory builds them,
  so they are not in the live catalog. The conformance inventory test
  checks that the MCP list equals the live donor catalog and that no served
  tool or action names an excluded subsystem. The four data references to
  deleted paths stay as donor text. Step E1 later deleted
  them from the registry (Step E, below).

### Lite-new behaviour removed

The Lite-new rules of plan §7.6 are gone, with the code that implemented
them. Conformance no longer asserts them:

- delegated internal turns (`internal/claim`, `internal/release`, minted
  per-turn credentials, `PSFN_LITE_INTERNAL_HOST`), Lite free time and rest;
- turn leases and lease recovery (`turn_lease_active`), and worker
  recovery, requeue and effect receipts;
- write receipts and `writeId` replay;
- the continuity backup and restore API;
- the settlement fields `partialReply`, `delivery`, `by`, `toolCallCount`
  and `postTurn`, and the checkpoint re-append of an unarchived turn;
- Lite's typed attribution origins and the `TOOL_INVENTORY` registry (now
  the donor's message classes and tool registry).

### What a host-driven turn cannot reproduce

These are limits of the bridge and the Hermes plugin over donor turns. Each
one was found in the donor code or in a run:

- **No model call after the host's final reply.** If the donor asks for
  another completion after `settle` (a corrective re-prompt), nobody is left
  to answer. The relay fails that call (`NonRecoverableFallbackError`), and
  the donor records the turn as it ends on that failure.
- **Donor turn limits apply to the host's loop.** A host turn is held to the
  donor's 36 assistant steps and its 5-minute parent-turn wall time
  (`core/agent/turn-limits.ts`). When the donor ends the turn on one of
  them, the host's next tool call gets `turn_ended`. The bridge also fails a
  turn the host neither continues nor settles within `hostTurnTimeoutMs`
  (`host_turn_timeout`).
- **One agent.** The donor runs one foreground turn at a time. While a host
  turn is open, another principal's `prepare` is refused as `unavailable`
  (`capability: companion_turn`, HTTP 503), and the same principal's is
  refused as `turn_already_open` (409).
- **The donor may rewrite the reply.** `settle` returns the reply as the
  donor recorded it, after its own reply handling. Hermes has already
  delivered its own reply after the hook, so the participant sees the
  host's text. There is no streaming.
- **Provider-side retries see the host.** The donor's stream adapter re-asks
  a completion whose tool call has empty required arguments
  (`core/agent/stream-adapter.ts`, `corrupt_empty_arguments`). Such a host
  call then returns "The companion runtime returned no result for this
  tool call." rather than the tool's own validation error.
- **Extended tools.** An extended tool the turn has not loaded is answered
  with the donor's unknown-tool correction, which names `toolset`, exactly
  as a `SubstrateAgent` model call is.
- **History shown twice.** The rendered context carries the donor's session
  history. Hermes also shows the model its own transcript, so earlier turns
  of the conversation appear in both.
- **Orientation is per conversation.** The donor's human block of `orient`
  belongs to one conversation. Another session of the same contact (another
  Hermes session id) does not see it. A concern scoped to the contact
  (`contactId`, `sensitivity: personal`) is visible across that contact's
  sessions and hidden from other contacts. A concern without `contactId` is
  global, so a friend sees it too.
- **Dead processes.** When the Hermes plugin starts, it settles as failed
  (`hermes_process_ended`) the open turns of exited processes of the
  profile, before it prepares anything. So a successor never sees
  `turn_already_open` for a dead process's turn. Until a successor starts,
  the bridge's host-turn timeout ends such a turn.
- **An explicit tool request is forced by the host, not by Lite.** The donor
  forced each model call of a turn whose participant named tools ("call
  tool_search, then orient"): its provider client offered only the next
  requested tool with a required choice, or no tool once the sequence ran
  (`primitives/llm/client-request-capability.ts` `applyExplicitToolChoice`,
  `buildPiContext`), and its stream adapter fails the turn on any other
  answer (`core/agent/stream-adapter.ts`, `explicit-tool-request.ts`,
  `tool_contract_incompatible`). Lite hands that choice to the host per
  model call (Shakedown fixes, below), and the Hermes plugin applies it.
  What it cannot reproduce:
  - the donor re-asked its model once when a required call was missing
    (`missing_required_call`). A host turn cannot be re-asked; a host model
    that ignores the forced choice fails the turn;
  - the plugin forces only Hermes's `chat_completions`, `codex_responses`
    and `anthropic_messages` request shapes. On another API mode, or when
    Hermes's request has neither the requested tool nor Tool Search's
    `tool_call` bridge, the request goes unchanged and the turn may fail as
    before. Hermes's own tools are hidden on a forced step, as the donor
    offered only the one tool;
  - under Hermes Tool Search (on by default) the donor's one tool is
    offered as Hermes's `tool_call` bridge narrowed to that tool, not as
    the tool itself: the model calls `tool_call` with one
    `{name, arguments}`, and Hermes unwraps it before its hooks and
    dispatch (round r2, below). The model's call is one level deeper than
    the donor's, and Hermes checks its arguments against the registry
    schema before the tool runs (`tools/tool_search_validation.py`
    `validate_deferred_call_args`);
  - the donor disabled reasoning for a forced call only where its provider
    required it (Kimi Code). The plugin turns thinking off on a forced step
    for the providers in `toolchoice.py` `FORCED_CHOICE_WITHOUT_THINKING`
    (DeepSeek, Kimi; matched by Hermes provider id or host) and for every
    Anthropic Messages request. A provider that refuses a forced choice
    while thinking but is not in the table (for example a DeepSeek model
    behind an aggregator, which takes another reasoning wire) still refuses
    the request;
  - the donor resolves the contract for the routed model's API and refuses
    a turn with an explicit request on any API it cannot force
    (`providerToolChoice`: only `openai-completions` and `pi-messages`).
    The relay keeps that check on Lite's configured model, so a host turn
    with an explicit request fails when Lite's own model is on another API,
    whatever the host's model is.

### Deleted and modified Lite tests

These are Lite's own tests, not donor tests: the donor-test record is
`deleted-tests.tsv` and `modified-tests.tsv`, and Step C changes neither.
Before Step C, `lite` had 52 files and 440 tests. After it, `lite` has 11
files and 83 tests.

Deleted with the code they tested:

- `tests/core/*` (20 test files and 10 helpers): Lite core activity,
  attribution, automata, backup, contacts, continuity handlers, dispatch,
  emotion, episodes, free time, identity, ingress, journals, memory,
  schedule, self-state, sessions, `TOOL_INVENTORY` and turn lifecycle;
- `tests/adapters/*` (9 test files and 2 helpers): the Lite Postgres
  stores, migrations, the JSONL session archive, history backup and
  continuity recovery;
- `tests/boundary/{adapter,core,harness,mcp}-imports.test.ts`: the Lite
  core's import rules. They are replaced by `host-imports.test.ts`, which
  checks that each host package reaches the companion only through its one
  `companion.ts` module and lists exactly the donor modules it uses;
- `tests/lifecycle/bridge.integration.test.ts` (and `bindings.ts`): the
  Lite turn ledger bridge. It is replaced by
  `host-turns.integration.test.ts`;
- `tests/mcp/{argument-drift,authority,internal-turns,inventory-parity,leakage}.test.ts`,
  `postgres.integration.test.ts` and `bindings-fixture.ts`: Lite argument
  descriptions, the dispatcher's admission, minted internal-turn
  credentials, and `TOOL_INVENTORY` parity. Transport authentication and
  error replacement moved to `transport.test.ts`;
- `tests/pi/{companion-harness,internal-activity,turn-settlement}.test.ts`
  (and `faux-brain.ts`, `pi-world.ts`): the Lite Pi harness;
- `tests/standalone/shutdown.integration.test.ts` (and `lite-config.ts`,
  `standalone-world.ts`): the Lite tick loop and stacks;
- conformance scenarios `05-free-time`, `06-free-time-delegated`,
  `07-authorship`, `08-worker-recovery` and `09-backup-restore`, and
  `host/brain.ts` (the scripted Lite brain). 07 asserted Lite's
  attribution origins. It is replaced by `05-attribution` on donor
  behaviour.

Rewritten for the donor core, with the same subject:

- `tests/mcp/bindings.test.ts`, `stdio.test.ts`, `mcp-world.ts`: the
  credential and binding rules are unchanged, and a fake host tool port
  stands in for the Lite dispatcher;
- `tests/pi/model-ports.test.ts`: only the model and embedding ports;
- `tests/standalone/config.test.ts` (adds the `workspaceDir` overlap
  test) and `standalone.integration.test.ts` (`init`, `once` and `serve`
  over the donor runtime);
- the conformance contract, host, drivers and runner, and scenarios
  01-04: a Pi turn is a donor-driven turn (`agentLoop.handleMessage`, with
  the scripted model making the planned tool calls), and a Hermes turn is
  `prepare`, MCP and `settle`. Both run on the operator's donor session
  channel. `02-abandoned-turn` now waits out the host-turn timeout instead
  of a lease, and it drops the conflict step that the plugin's own
  recovery makes unreachable from the real Hermes runner;
- `tests/conformance/absence.test.ts`:
  - `excludedName` moved to `excluded-names.ts`, unchanged, so the
    inventory test can use it.
  - The product-file floor went from more than 50 files to more than 40:
    there are now 46 product files, and a truncated listing still fails.
  - One donor contract key is allowed by name and file: `channels` in
    `apps/standalone/src/runtime.ts`, the donor's `Contact.channels`
    identity links.
  - The tool rule now reads the donor registry minus the 17 scaffolding
    surfaces, because `TOOL_INVENTORY` is gone. Action names are checked
    on the live catalog by the conformance inventory test, which also
    checks the MCP list against the donor catalog. That test replaces the
    inventory parity test.
- `tests/hermes/fixtures/lite-host.ts`: it now runs the conformance host
  over a throwaway database. A seed Pi turn writes a contact-scoped concern.
- Donor test `companion-runtime.boot.integration.test.ts`: one import was
  re-pointed from `packages/pi/src/core.ts` (deleted) to
  `packages/pi/src/result.ts`, which has the same `ok`. No assertion
  changed.

Hermes plugin tests (Python):

- `test_host_contract.py` deleted two tests for delegated internal turns:
  `test_a_delegated_internal_turn_prepares_the_trigger_lite_fixed_and_says_it_is_internal`
  and
  `test_the_internal_turn_host_runs_a_claimed_turn_with_the_minted_credential_and_releases_it`.
  The rest moved to the new wire: `sessionId` in `prepare` and
  `checkpoint`, the `completed`, `interrupted` and `failed` outcomes
  without `partialReply`, and no `toolCallCount`.
- `test_turn_integrity.py` deleted
  `test_a_subagent_inside_an_internal_turn_never_drives_the_turn_or_uses_lite_tools`.
  Its compression test now asserts that both turns prepare in the root
  session.
- `test_e2e_lite.py` was rewritten to donor tools, the seeded concern and
  donor context history (three tests renamed for that).
  `test_conformance.py` and `conformance_runner.py` were rewritten to the
  new scenarios. The inventory test now checks that Hermes registers
  exactly the donor catalog Lite serves.

### Other changes

- Root `tsconfig.json`: `exactOptionalPropertyTypes` was removed and
  `esModuleInterop` added, as in the donor's compiler options, because the
  host adapters now type-check against donor types.
- Packages: `knip` (dev, unused) and the dead `test:ci-rules` script were
  removed, along with 975 lockfile lines. `@earendil-works/pi-agent-core`
  left `packages/pi/package.json`. The root keeps it for the companion.
  No package was added.

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
| `json-rpc-2.0` | 1.7.1 | vendored scaffolding; removed in B7 |
| `ws` | 8.21.0 | vendored scaffolding; removed in B7 |
| `yaml` | 2.9.0 | vendored scaffolding; removed in B7 |
| `ipaddr.js` | 2.2.0 | vendored scaffolding; removed in B7 |
| `discord.js` | 14.26.4 | vendored scaffolding; removed in B7 |
| `pdfjs-dist` | 5.4.394 | vendored scaffolding; removed in B7 |
| `@redis/client` | 6.0.1 | vendored scaffolding; removed in B7 |
| `@total-typescript/shoehorn` (dev) | 0.1.2 | donor tests |
| `tsup` (dev) | 8.5.1 | donor test `persistence/sessions/turn-records.test.ts` compiles the recovery worker |
| `@types/ws` (dev) | 8.18.1 | vendored scaffolding; removed in B7 |

`@character-foundry/character-foundry` was not added (not allowed). B6 added
no package: the boot proof uses `@earendil-works/pi-ai` (already a root
dependency through `packages/pi`) and imports `packages/pi/src` by relative
path.

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

B7 removed the seven scaffolding packages and `@types/ws` from the root
`package.json` (none was in `packages/companion/package.json`), and the
`discord.js` / `@discordjs/rest` `undici` overrides and the `lodash` override,
whose only consumer was discord.js. `npm install` removed 38 lockfile entries
and added or changed none. `ws` and `yaml` stay in the tree as transitive
dependencies of other packages. The `basic-ftp`, `fast-uri`, `fast-xml-*`,
`ip-address` and `tar` overrides already matched nothing in the tree before
B7; they are left as they were.

## Lite-side amendments

- `tests/conformance/absence.test.ts` (rewritten in B7): the companion's
  classifier and logger packages (`@huggingface/*`, `onnxruntime-*`, `winston`)
  are allowed (operator ruling), and the Automata Bus and `SubstrateAgent`
  are core, so their names are no longer excluded. The test still bans the
  Discord, Redis, PDF and card-import packages (`@character-foundry/*`) and
  the donor in the manifest, overrides, lockfile, node_modules and every
  import. In Lite's own code it bans names whose words include wiki, shard,
  fleet, charge, gateway, cogsec, channels, skill(s), discord or redis, or
  the pairs findings bus, gateway server and cog sec, and governed tools of
  those names. Hermes Python still may not import transformers, onnxruntime
  or winston: the plugin has no such dependency. `packages/companion` keeps
  donor names verbatim, so instead of the name rule it is held to the
  deletion record: every deleted row of `vendored-files.txt` (scaffolding,
  cut, source-text, test-support, asset, seed) is absent from disk, and no
  file of the package imports, re-exports, dynamically imports, mocks
  (`vi.mock`, `doMock`, `importActual` and the rest) or reads through `new
  URL(..., import.meta.url)` a deleted path. A first block of tests checks
  the checker on positive and negative cases, and each rule was checked by
  mutation (a temporary import of a deleted path, a Lite identifier named
  after an excluded subsystem, a deleted file restored); each failed the
  test.
- Root `tsconfig.json` excludes `packages/companion`; it has its own
  `tsconfig.json` with the donor's compiler options (no
  `exactOptionalPropertyTypes`, `esModuleInterop` on, tests excluded from the
  typecheck as in the donor). Root eslint ignores `packages/companion/**`.
- Root `vitest.config.ts` runs two projects: `lite` (unchanged settings) and
  `companion` (`packages/companion/vitest.config.ts`).

## Operator automata rules

The operator's four automata rules, applied only where the extracted donor
code differed. Evidence is file:line at the donor revision unless it names
Lite (`packages/companion/...` after this step) or Hermes at
`f0187332d13679e2ace74d1f0eb399eb91a90571`.

| Rule | Donor | Lite change |
|---|---|---|
| 1. Every worker write is exactly-once across attempts, via a stable write key | **Differed.** The worker port minted `randomUUID()` event ids for every finding, relation and handoff write (`faculties/automata/bus/production-worker-adapter.ts:266, 308, 330`), so the same write repeated by the model or by a later attempt became a second Bus event. The store already replays an incumbent id only for byte-identical content. | Stable write keys (below). |
| 2. The worker turn budget resets per attempt, with a hard, terminal attempt cap | **Kept where the donor does it.** A subagent run gets its own `maxTurns` (`faculties/subagents/faculty.ts:132`, default 1) and is one attempt: a failed or cancelled run cannot run again (`faculties/automata/bus/class-lifecycle.ts:98-106`); a retry is a new run (`workerGeneration + 1`, `sourceRunId`; `faculties/memory/extraction/memory-extraction-automata-run.ts:104-107`). Durable background work has a terminal attempt cap (`persistence/postgres/background-work-store.ts:1497-1498`; test `core/agent/background-work/supervisor.test.ts:1260` "retries failures with bounded attempts and never hides the terminal state"). | None for those paths. Hosted attempts (rule 4) get a fresh budget each and a terminal `maxAttempts`. |
| 3. Many automata run concurrently; exclusivity only per declared key | **Kept: the donor already does it.** The background supervisor runs up to `maxConcurrentSessions` jobs at once with one active job per `logicalSessionId` (`core/agent/background-work/supervisor.ts:239, 275`; test `supervisor.test.ts:765` "runs different sessions concurrently while preserving one active job per session"); its claim passes are serialized (`supervisor.ts:446`), the jobs they claim are not. The subagent faculty runs up to `subagentMaxConcurrent` workers (`faculty.ts:131`, default 8) plus per-role caps, each launched on its own microtask (`faculty.ts:606`). The scheduler tick is serial by design ("Ticks stay serial — lanes such as free time rely on one handler finishing before the next due task starts", `core/scheduler/scheduler.ts:714`); it orders scheduler lanes, not automata, and is kept. The Bus writer serializes appends per companion in process and the Postgres store takes a per-companion advisory transaction lock: that is the sequence allocator, not a worker lock. | None. The hosted executor has no global lock: the only exclusivity is one live attempt per task. |
| 4. Automata are ephemeral shared workers whose task and scope core derives from their source, runnable as Hermes subagents | **Differed.** Every automaton ran in core (`faculty.ts`, `runHandle`). | Hosted automata (below). |

### Stable write keys (rule 1)

- `worker-access-tool.ts` derives a write key from the validated operation
  (`automataBusWorkerWriteKey`, canonical JSON of the normalized operation:
  for a note, `{action, text}`) and passes it with every note, append,
  correct and handoff.
- `production-worker-adapter.ts` derives the event id as
  `stableId(namespace, [companionId, automatonClass, taskId, writeKey])`.
  The task, not the run, scopes it, so every attempt of a task maps the same
  write to the same event. A port call without a key derives one from its
  own input the same way.
- The stored body names its run (`context.runId`, the note's
  `automata-run:<runId>` evidence), which differs between attempts, so the
  writer does not rely on the store's byte comparison: for these writes it
  reads the incumbent first (`replayIncumbent`) and answers it with
  `inserted: false`. The first attempt's event stands.
- A correction (`correct`: corrects, supersedes, retracts) asks the writer
  for the incumbent (`CanonicalAutomataBusWriter.replayExisting`, inside the
  append serialization) before it reads its target. The first correction
  removed the target from `automata_bus_current_findings`
  (`faculties/automata/bus/postgres-store.ts` `appendAllocated`), so a
  repeat that read the target first failed with "correction target is not
  current or visible" (review finding after Step D, fixed). The repeat now
  returns the stored relation with `inserted: false`. Guards:
  `worker-write-keys.test.ts` (the in-memory stand-in
  `test-support/in-memory-automata-bus.ts` now removes a relation's target
  from its current set, as the Postgres store does) and the Postgres case
  "replays a correction repeated by the next attempt" in
  `worker-write-keys.integration.test.ts` (supersede and retract). With the
  pre-fix adapter, 3 of those 8 tests fail.
- Behaviour change: identical repeated worker writes of one task now
  coalesce into one event (the donor stored each). Distinct text, action or
  task still give distinct events.

### Hosted automata (rule 4)

- Core: `faculties/subagents/host-execution.ts` (`HostedAutomataExecutor`).
  `SubagentFaculty` gets an optional `hostExecution` port; without it the
  donor path is unchanged. With it, a spawned automaton still opens its
  governed run, role and bound `automata_bus` tool in core (so
  `subagent.bounded` keeps opening from `faculty.ts`), and then runs as a
  sequence of host attempts instead of `runHandle`:
  - an attempt is claimed by one host instance (the bound principal plus
    the body's `hostInstance`) and gets a fresh per-attempt credential
    (32 random bytes; core keeps only its SHA-256) and a fresh budget: the
    host's declared iteration budget, refused (`budget_exceeds_policy`)
    above the policy's `maxIterations`;
  - core ingress binds the credential to that attempt only: another host
    instance or principal is refused (`not_attempt_owner`), and an ended
    attempt's credential is refused (`attempt_ended`, HTTP 410);
  - an attempt the host does not renew (heartbeat or Bus call) within
    `leaseMs`, or reports `lost` or `failed`, ends; the task gets its next
    attempt until `maxAttempts`, which ends it failed
    (`attempt_cap_exhausted`). That is terminal: no further claim, and every
    credential of the task is refused;
  - the child persists only through `automata/bus`, which runs core's
    governed tool for the run, so its writes carry stable write keys;
  - a cancel from core is answered at the next heartbeat
    (`cancel_requested`); a waiting task is cancelled at once.
- Lifecycle bridge: `automata/claim`, `automata/heartbeat`, `automata/bus`
  and `automata/report` (`packages/lifecycle/src/http.ts`, strict bodies in
  `wire.ts`), mounted only when the standalone config sets
  `lifecycle.automata` (`{maxAttempts, leaseMs, maxIterations}` or `null`).
  An automaton's goal and context are the companion's own work, so only a
  principal bound to the primary contact may use them (`denied:
  automata_not_admitted` otherwise).
- Hermes plugin: `integrations/hermes/psfn_lite/automata.py`, on when
  `psfn-lite.json` sets `automata: {claim_limit}`. At the start of each
  bound root turn it claims attempts, declaring
  `tools.delegate_tool.DEFAULT_MAX_ITERATIONS` (it claims nothing if Hermes
  no longer has it). It launches one child per attempt through
  `ctx.subagent_lifecycle` and binds the child's session from
  `subagent_start` (which Hermes fires inside `launch`,
  `tools/delegate_tool.py:2083`) to the attempt credential. It watches the
  child on its own thread, under the turn's `contextvars` context, which
  holds the parent Hermes bound. The watcher renews the lease, stops the
  child when core asks or when core ended the attempt, and reports
  SUCCEEDED as `succeeded` (with `api_calls`), FAILED as `failed`,
  CANCELLED as `cancelled`, and INTERRUPTED or UNKNOWN as `lost`. A Hermes
  process that exits stops renewing, so its attempts end as lost at their
  lease. The child's `automata_bus` tool (registered with
  `ctx.register_tool` in toolset `psfn_lite`; schema
  `automata_bus_tool.json`, checked against the donor tool by
  `tests/hermes/automata-bus-tool.test.ts`) forwards each call as the
  attempt; any other session is refused.
- `CompanionRuntime` exposes `subagentFaculty`, the control port the
  `subagent` tool drives.

What the hosted path cannot do, from the Hermes public API at the tested
revision:

- **The budget is Hermes's, not core's.** `SubagentLaunchRequest` has no
  iteration field, and `launch` builds every child with
  `max_iterations=DEFAULT_MAX_ITERATIONS` (250;
  `agent/subagent_lifecycle.py:218-234`, `tools/delegate_tool.py:1092`).
  The host declares that number and core checks it against its policy;
  `delegation.max_iterations` applies to `delegate_task` only. A policy
  `maxIterations` below 250 therefore refuses Hermes claims.
- **A child that used its whole budget looks completed.** The public result
  reports SUCCEEDED and `usage_metadata.api_calls`; the delegate's
  `truncated` flag (`delegate_tool.py:3125`) is not exposed.
- **The memory-provider context has no `subagent_lifecycle`.** Hermes's
  `_ProviderCollector` forwards only `register_*`
  (`plugins/memory/__init__.py:594-627`), so the plugin builds a
  `PluginContext` for itself as Hermes does for a memory provider
  (`:629-641`).
- **The child's tools are its parent's.** With no `allowed_toolsets`, a
  lifecycle child inherits the parent's enabled toolsets
  (`delegate_tool.py:1664-1699`), so the profile must enable the
  `psfn_lite` toolset for the child to have `automata_bus`. Lifecycle
  validation rejects toolset names outside Hermes's static `TOOLSETS`, so
  the plugin cannot name it explicitly.
- **No follow-up messages and no reconnect.** A hosted automaton takes its
  task once (`message` throws), and a restarted Hermes cannot reconnect a
  child (`RECONNECT_UNAVAILABLE`); its attempt ends at its lease and the
  task retries.
- **Claims ride on root turns.** The plugin claims only inside a bound root
  turn, where Hermes binds the lifecycle parent; a waiting automaton waits
  for the next such turn.
- **Spawn from a Lite turn (since Step E4).** At Step D Lite fixed the
  capability tier at the donor seed's `nursery` (seam 3.17), which does not
  grant `shard.spawn`, so the donor `subagent` tool was denied in every
  turn. Step E4 made the tier an owner file with the default `autonomous`,
  and the integration test now spawns through the `subagent` tool in an
  owner turn.

Tests added. Step D deleted and modified no donor test; the companion-project
files are listed in `packages/companion/extraction/added-tests.tsv`.

- `faculties/automata/bus/worker-write-keys.test.ts` (6): a note repeated
  in one attempt, the same note from the next attempt, distinct writes stay
  distinct, a handoff and a correction repeated across attempts, a direct
  port write, and (review fix) a supersede repeated after its target left
  the current set. With random ids restored, 4 of the first 5 fail.
- `faculties/automata/bus/worker-write-keys.integration.test.ts` (2): the
  same over the real Postgres store across a process restart, and (review
  fix) a supersede and a retract repeated by the next attempt.
- `faculties/subagents/host-execution.test.ts` (13): a fresh budget and
  credential per attempt and a terminal cap, a budget above the policy
  refused, completion on a later attempt, two tasks running at once with
  one live attempt per task, several host instances, the credential bound
  to its attempt and owner, lease expiry as a lost child, Bus calls through
  the governed tool, cancel, malformed reports, close. Through the real
  `SubagentFaculty`: a lost child retried with its Bus write stored once,
  the cap failing the automaton, and cancel through the heartbeat.
- `tests/lifecycle/hosted-automata.integration.test.ts` (2): the routes
  over the real standalone runtime and Postgres, from spawn to completion.
- `tests/hermes/automata-bus-tool.test.ts`: the plugin's tool schema is the
  donor tool's.
- `integrations/hermes/tests/test_hosted_automata.py` (10): inside the
  pinned Hermes with its real lifecycle service, hooks and tool dispatch.
  Only the child's model loop is replaced, as Hermes's own lifecycle tests
  do. Cases: credential and budget per child, `automata_bus` refused
  outside an attempt, lost and failed children, cancel through the
  heartbeat, a child whose attempt core ended, two children at once, no
  claim without `DEFAULT_MAX_ITERATIONS`, no claim from subagent or cron
  turns, and two reads of Hermes's source (the `launch` budget and the
  `subagent_start` call).

Lite tests changed for the new required config fields (these are not donor
tests): `tests/standalone/config.test.ts` (two lifecycle documents gain
`automata: null`; one new case), `tests/conformance/host/host.ts` and
`tests/lifecycle/bridge-world.ts` (`automata: null` by default), and
`integrations/hermes/tests/conftest.py` and `test_config.py`
(`automata: null`; new cases).

## Review fixes after Step D

Five review findings after Step D. All five were checked against the code
and the records, and all five were real. Each is fixed below, and each fix
has a guard that fails without it.

**1. Autonomous lanes refused (blocker).** In Lite, the donor
`createProviderRuntimeServices` ran its no-model-usage-store branch. That
branch left the `LLMClient` without a `usageRecorder`. The client's
accountability guard (`primitives/llm/client.ts`
`assertAutonomousCallAccountable`) refuses every work-spec call whose lane
is not `foreground_chat` when there is no recorder. As a result, every
autonomous lane was refused with "has no usageRecorder configured":
post-turn appraisal, biography, sleeptime, concern review, free time and
the other background lanes. Only foreground chat ran. A Postgres-backed
donor agent always had the store, so this was a seam 3.1 cut that was
never recorded. Fix: the accountability seam is a port again.
`createProviderRuntimeServices` takes an optional `ModelUsageRecorder` (the
donor interface, `shared/telemetry/model-usage.ts`). It gives the recorder
to the `LLMClient` and wraps the embedding provider in the donor's
`withEmbeddingUsageAccounting`, with the donor's configured estimated
rates. `startCompanionRuntime` requires a recorder.
`apps/standalone/src/model-usage.ts` is the host's recorder: in-memory
totals of calls, failures, tokens and effective cost, by runtime lane and
by provider/model (`LiteRuntime.modelUsage()`). It holds no content,
session, channel or contact ids. It is not durable, and Lite has no budget
queries, alerts or exports. The 3.1 row of `cuts.tsv` records the
amendment. Guards: the boot proof
(`companion-runtime.boot.integration.test.ts`) "runs autonomous lanes
through the host model-usage recorder". It runs turns until a
`post_turn_appraisal` completion is recorded as a success, checks that
foreground chat is recorded, and checks that no diagnostic says "has no
usageRecorder configured". Without the recorder it fails on the refusal.
`tests/standalone/model-usage.test.ts` covers the ledger arithmetic.

**2. Promoted files' donor tests missing (major).** 72 colocated donor
tests of promoted files were never selected. They are now the `promoted`
selection: a donor baseline (Test baseline, above), `baseline.json`,
`tests.tsv`, and every deletion and edit recorded ("Promoted selection
(after Step D)", in Deleted and modified tests). The B1 note that promoted
files bring no tests is replaced.

**3 and 5. Stale provenance, cuts and size (major).** `docs/provenance.md`
was regenerated from Git blobs. Its tables now come from
`packages/companion/extraction/provenance-tables.py`, which runs `git
ls-tree` on `HEAD` and on the donor commit, instead of from a scratch file
list. The old tables matched the tree up to Step C (1,924 files) but not
Step D or the promoted tests. `cuts.tsv` has seam `D` rows for every Step D change to a donor
file and for the new files: `production-worker-adapter.ts` (stable ids,
`replayIncumbent`, `replayExisting`), the worker-access write key
(`worker-access-{contracts,operation,tool}.ts`), `faculties/subagents/
faculty.ts` (the `hostExecution` port, `runHostedHandle`) and the
`companion-runtime.ts` and `composition.ts` wiring
(`automataHostExecution`, `hostExecution`). The new files are
`host-execution.ts`, its test, the write-key tests and
`test-support/in-memory-automata-bus.ts`. Measured size (below) is for the
final tree.

**4. `correct` not exactly-once (major).** The worker port's `correct`
read its target from `automata_bus_current_findings` before computing its
stable id. The first correction removes its target from that projection
(`postgres-store.ts` `appendAllocated`). So the same correction, repeated
by the model or by the next attempt, failed with "correction target is not
current or visible" instead of replaying. Fix: `correct` computes the
stable id first and asks the writer for the incumbent
(`replayExisting`, inside the append serialization) before it checks the
target. The in-memory stand-in used by the unit tests now models the
projection. Guards: a unit case and a Postgres case (Stable write keys,
above). With the pre-fix adapter, 3 of the 8 write-key tests fail.

**Validation after the fixes** (2026-11-09, about 05:36Z). Root `tsc`,
companion `tsc` and `eslint .` all exited 0. The plain validation command,
with a JSON reporter, exited 0: **770 files and 9,192 tests, all passed**
(`lite` 14 files / 89 tests, `companion` 756 files / 9,103 tests).
Comparison: `baseline: 807 files / 10107 tests; deleted: 55 files, 1031
tests; matched: 9076; Lite additions: 4 files, 27 tests`, `equivalent:
every remaining baseline test has its baseline status`. That is the
baseline's 10,107 tests minus 1,031 deleted (994 before, 37 from the
promoted selection). The edited tests are among the matched. The Hermes
plugin suite (`integrations/hermes/.venv`, Hermes `f0187332`) passed 64 of
64. Afterwards, the set of running Docker containers was the same as
before the run, and no `/tmp/lc-*` directories were left.

## Step E: operator rulings (2026-11-08/09)

Seven operator rulings, applied in order. Rows in `cuts.tsv` carry seam
`E<n>`. Deleted and edited donor tests are in `deleted-tests.tsv` and
`modified-tests.tsv` with the same label.

### E1: cut tool surfaces stay cut

Native Pi and Hermes tools already do filesystem, shell, web, skills, wiki
and the rest. The donor rebuilt them only for its own closed deployment.
B7 deleted the factories of 17 surfaces. E1 deletes what still named them,
and rebuilds nothing:

- the 17 entries of `CANONICAL_FIRST_PARTY_TOOL_SURFACES`
  (`core/agent/tool-surface/registry.ts`), with their retired aliases. The
  registry is now exactly the 15 surfaces Lite factories build. So
  `factory-descriptions.test.ts` is the donor's text again, and the B7
  exclusion set (`SCAFFOLDING_HOSTED_TOOL_SURFACES`) is gone;
- 16 description contracts (`tool-surface/descriptions/*`) and the
  `read_only` variant of `repo`. The `notify` contract stays, because the
  kept ICP candidate projection (`icp-candidate-notify-tool.ts:71`) renders
  its narrowed description from it. No `notify` tool is built, so it is
  never served;
- the 17 rows of `TOOL_VIEWER_GATE_DECISIONS` (`viewer-gates.ts`);
- the `shard.long_horizon` automata class, whose adapter pointed at the
  deleted `faculties/shards/manager.ts` (`class-adapters.ts:94`): its
  adapter, its `PRODUCTION_AUTOMATA_CLASSES` entry, its spawn path, its
  Bus eligibility in `automata-policy.seed.json` and its retention rule.
  The certification test is the donor's text again (since B7 it had
  treated the class as absent). An owner `automata-policy.json` that still
  lists the class is now refused at start (unknown automata class);
- the data references to the deleted wiki pass: the `memory.sleeptime.wiki`
  prompt (`prompt-registry.ts:276`) and the `wiki_curation` persona seed
  (`persona-preamble-seeds.ts:146`). The disabled sleeptime wiki stage
  reads neither. Two comments that named deleted files
  (`shared/contracts/world-notes.ts:9`,
  `system/config/companions-config.ts:33`) are rewritten;
- `createRepeatedScreeningFailureAlertHandler` (`operator-alerts.ts`),
  unused since B7.

Kept on purpose: `system/capabilities/requirements.ts` still maps the cut
names to their donor tokens, so a host tool registered under one of them is
still held to those tokens (fail closed).

Behaviour change: none for any served tool. A host tool named like a cut
surface would now be an ordinary unknown tool: last in presentation order,
not viewer-gated, and its old alias names are not refused or corrected.
No Lite host registers one. Tests: 16 deleted (their subject is a cut
surface or the cut class; three are the `shard.long_horizon` cases of an
`it.each` over the seed's Bus-eligible classes in
`worker-execution.test.ts`, whose file is unchanged) and 22 rows edited. Where the subject is a kept
mechanism (alias correction, presentation rank, viewer ceiling), the
fixture is re-pointed from the cut surface to a kept one, and the
assertions keep their shape. `tests/conformance/absence.test.ts` now also
fails if the registry lists one of the 17 again.

### E2: session integrity comes from the host

The donor signs every session journal entry with an HMAC chain
(`persistence/journals/journal/integrity.ts`, `createKeyringIntegrityProvider`
at `persistence/sessions/store-primitives.ts:144`) when its composition gets a
`SessionIntegrityProvider`. Lite's core is unchanged. The host supplies the
provider:

- **Standalone, the operator's own Pi turns and the web connector (MCP).**
  With `"sessionIntegrity": {"kind": "keyring"}` the standalone host reads
  the donor keyring variables (`GATEWAY_SESSION_HMAC_KEYS`, `_KEY`,
  `_ACTIVE_VERSION`, seam 3.8) and passes the donor provider over them
  (`apps/standalone/src/runtime.ts:150-156`). The runtime then composes the
  donor's production session mode. With `keyring` and no keyring in the
  environment, the host refuses to start. With `{"kind": "unsigned"}`, the
  journals are not signed and load without verification: the donor's
  non-production mode (`composition.ts:155-165`), which logs "Session
  integrity mode: disabled". A host that embeds the core keeps the donor's
  result: no provider means no chain.
- **Hermes.** A Hermes install is one source serving one user: its desktop
  app, gateway, mobile, Telegram and CLI surfaces share one install. Its
  sessions are bound to the install:
  - The binding is Hermes's install id: the file `install_id` in the Hermes
    root (`hermes_constants.get_default_hermes_root()`). Hermes writes a uuid4
    hex id there (`hermes_cli/web_server.py` `_INSTALL_ID_FILENAME`,
    `_read_or_create_install_id` at f0187332; `hermes_cli/install_identity.py`
    `read_or_create_install_id` at 2bd378e), shared by every profile of the install,
    stable across restarts and code moves. The id is public: the dashboard's
    public status payload shows it. `hermes_cli/process_identity.py:70` `install_id()` is
    not used: it hashes the source path, so it changes when the code moves,
    and it names the code, not the install.
  - The plugin reads the id (`integrations/hermes/psfn_lite/config.py`
    `hermes_install_id`) and sends it as `hermesInstallId` on prepare and
    checkpoint. It never creates the id. Without it, the plugin drives no
    turn and blocks the Lite tools. The per-process `hostInstance` keeps its
    own job (turn ownership, the dead-process sweep, automata ownership).
  - Lite's config names the install it serves (`lifecycle.hermesInstallId`).
    The bridge refuses a prepare or checkpoint for another install with 403
    `wrong_install` (`packages/lifecycle/src/bridge.ts`).
  - The chain: the entries of a Hermes conversation (the donor channel
    convention `api:hermes:<digest>`, `externalMemorySessionId`) are signed
    with the donor HMAC chain over the env keyring scoped to the bound
    install. For each key version the key is
    `HMAC-SHA256(key, "psfn-lite hermes-install session keyring v1\n" + installId)`
    (`apps/standalone/src/session-integrity.ts`). The install id names the
    binding. The keyring is the secret, so the install id alone does not give
    the key. A journal written for another install, or with the plain
    keyring, fails verification. Every other conversation keeps the plain
    env keyring.
- Decided: the scope is chosen per entry from its channel id, not for the
  whole runtime. One standalone runtime serves the operator's own turns and
  one Hermes install at the same time.

Tests: `tests/standalone/session-integrity.test.ts` (the scoped keyring, the
chain, tampering, another install, the plain chain for other channels) and
`tests/lifecycle/host-turns.integration.test.ts` "binds the bridge to its
Hermes install ...". That test reads the journals the running runtime wrote:
every entry carries the donor HMAC and verifies. The Hermes conversation
fails under another install's keyring, under the plain keyring and after an
edit. The bridge refuses another install. The test installs now use
`keyring` by default (`tests/support/lite-install.ts`), so every integration
suite runs with the chain on. In the plugin suite, `test_host_contract.py`
covers the missing or malformed id and a `wrong_install` refusal.

### E3: memory deletion is approved through the host

The donor never lets the model delete a memory. The `memory` tool's
`action=delete` (`faculties/memory/tools.ts:1579-1623`) needs the proposal
store and a `MemoryDeletionApprovalPort`. It records a pending proposal
(`pending_partner_alert`), calls the port, and answers "Memory deletion
proposal <id> is pending Operator validation ... the memory remains
active". The memory is deleted only when the proposal is approved
(`approveMemoryDeletionProposal`). In the donor, the port was the gateway's
confirmation surface: its resolve approved or denied the proposal
(`app/agent/main.ts:583-602`), and at boot the pending proposals were sent
to the port again (`main.ts:603`). The capability tier does not change this
(E4).

Lite now passes a host port:

- **Hermes.** The human decision is Hermes's own approval gate, taken
  before the call runs:
  - The plugin's `pre_tool_call` returns
    `{"action": "approve", "message": ..., "rule_key": ...}` for a
    `mcp__psfn_lite__memory` call with `action: delete` inside an open Lite
    turn (`integrations/hermes/psfn_lite/lifecycle.py:213-244`). The message
    names the memory, the reason category and the explanation (truncated at
    400 characters). The `rule_key` is a digest of the memory id, category
    and explanation, so an `[a]lways` or session answer covers only that
    memory for that reason, never every delete.
  - Hermes sends that directive to `tools.approval.request_tool_approval`
    (`hermes_cli/plugins.py` `_resolve_block_from_details`): the CLI prompt
    or the gateway's approval message, with once, session, always and deny.
    A denial, a timeout, or a failure of the gate blocks the call. The model
    cannot skip it, because Hermes asks before it dispatches the call. In
    an unattended context with no human (not cron, not the gateway, no
    `HERMES_INTERACTIVE`) the gate fails closed.
  - A denied call never reaches Lite. No proposal is made, and the memory
    stays.
  - After an approved call ran, the plugin's `post_tool_call`
    (`lifecycle.py:246-272`) reads the proposal id from the result and calls
    the bridge route `memory-deletion/approve` with the install id, the
    proposal and the memory. It does this only when the call ran (`status`
    `ok`), is still a delete of the memory the human was asked about (another
    plugin's `modify` directive can change the arguments), and its turn is
    still open. Otherwise, or when Lite refuses, the memory is kept, the
    proposal stays pending, and the plugin reports it in the next turn's
    context.
  - Operator choices that approve without a prompt are Hermes's, not Lite's:
    `--yolo`, a prior `[a]lways` or session answer for the same rule key,
    and `approvals.single_query_mode: approve`. (`approvals.cron_mode` does
    not apply: a cron run is never a Lite turn, so its Lite tools are
    blocked outright.)
  - The plugin finds the memory as the donor tool does: `memory_id`, else
    its aliases `id` and `memoryId` (`shared/tool-argument-normalization.ts`
    `normalizeUnifiedMemoryArguments`), so the human is asked about the
    memory the call would delete.
- **Lite.** `HostMemoryDeletionApprovals`
  (`packages/lifecycle/src/memory-deletion.ts`) is the port. When the donor
  tool calls it from inside a host-driven turn (the request context's
  channel is an open host turn), it records the turn, its owner and the
  memory. The bridge route (`packages/lifecycle/src/http.ts:124, 167-185`)
  accepts the approval only:
  - from a principal bound to the primary contact (who decides deletions,
    as the donor's Operator did), else 403 `deletion_not_admitted`;
  - for the bound Hermes install (E2), else 403 `wrong_install`;
  - once per proposal, from the owner of the turn that requested it, else
    404;
  - for the same memory, else 409 `memory_mismatch`;
  - within the host-turn timeout and while that turn is open, else 409
    `approval_expired` or `turn_ended`.

  A refused approval uses up the request, so the proposal stays pending.
  An accepted one marks the partner alert and approves the proposal, as
  the donor's gateway did, and the memory is deleted.
- **Pending proposals.** A proposal made outside a host turn (the operator's
  own Pi turn, or the boot replay) stays pending, as the donor leaves a
  proposal until a decision arrives. `startCompanionRuntime` replays the
  pending proposals to the port at boot, as the donor did
  (`app/agent/companion-runtime.ts:1383-1388`, donor `main.ts:603`).
- **Standalone without the lifecycle bridge, the operator's own Pi turns
  and an embedding host.** The standalone host passes the port only when
  `lifecycle` is configured (`apps/standalone/src/runtime.ts:166-170, 213-215`).
  Without it, and in a host that passes no port, the donor tool answers
  "memory deletion proposal persistence and confirmation are not
  configured" and deletes nothing.

Tests: `tests/lifecycle/memory-deletion.integration.test.ts` (the donor
tool only proposes; only the primary contact, the bound install, the
requesting turn, the same memory and one answer approve; a settled turn and
a Pi-direct proposal stay pending), `tests/standalone/memory-deletion.integration.test.ts`
("not configured" with no port, at the `autonomous` default), and in the
plugin suite `test_host_contract.py` (the approve directive and its rule
key, the resolve after `ok`, nothing after `blocked`, a changed call and a
refusal reported) and `test_e2e_lite.py` (Hermes's real dispatch and CLI
approval prompt against a real Lite: a denial blocks the call and keeps the
memory, an approval deletes it).

### E4: the capability tier is an owner file, default `autonomous`

Lite had fixed the tier at `nursery` (seam 3.17,
`apps/standalone/src/substrate-config.ts:105`). Now it is
`capability-tier.json` again, as in the donor:

- `system/config/capability-tier-config.ts` is the donor file at e6a9546.
  It validates the file and fails closed: `tier` must be `nursery`,
  `apprentice`, `autonomous` or `custom`, and `customTokens` may hold only
  known capability tokens. The donor tier semantics (`tiers.ts`) are
  unchanged, so `custom` grants exactly `customTokens`.
- `config/capability-tier.seed.json` is back with the Lite default
  `{"tier": "autonomous", "customTokens": []}` (the donor seed is
  `nursery`). `lite-standalone init` seeds it with the other owner files.
- `loadInnerLifeConfig` reads it at the companion data root, as the donor
  did (`config-store.ts:197`, `runtime-config.ts:65-67`).
  `createFixedCapabilityAccess` (`app/agent/companion-runtime.ts:361`)
  resolves the grant from the tier and custom tokens, as the donor
  `CapabilityRuntime` did (`runtime.ts:88-92`).
- Decided: the file is read once at start, like every other Lite owner
  file. The donor's per-refresh reader (`system/capabilities/runtime.ts`)
  stays cut. An owner edit takes effect at the next start.

At `autonomous` the model may use `shard.spawn`, so an owner turn can start
an automaton through the `subagent` tool, and a lifecycle host runs it.
`tests/lifecycle/hosted-automata.integration.test.ts` now spawns through the
tool in a real turn (with the seed set to `nursery` the same test fails with
`Capability denied: tool "subagent"`). `memory.delete` is granted too, but
the donor tool still needs both the proposal store and an approval port.
Without a port it returns "memory deletion proposal persistence and
confirmation are not configured" and deletes nothing. With a port it only
creates a pending proposal. The memory is deleted only when a person
approves (`approveMemoryDeletionProposal`). So the tier does not let the
model skip approval (E3, above).

Tests: the donor `capability-tier-config.test.ts` and the subsystem-config
round trip are back unchanged, and their deleted rows are removed.
`capability-tier-per-companion.test.ts` and `runtime.test.ts` stay deleted
(their subjects stay cut), with reworded reasons.

### E5: fatigue is deferred, not dropped

Decided (operator ruling, item 5): fatigue stays cut, as seam 3.17 left it
(types only, the donor no-port turn path). It is deferred, not dropped.
Lite runs one companion. The donor's fatigue regulation (the fatigue budget,
human-attention pressure, the room-episode pressure ladder and its circuit
breaker, the social pot, `core/agent/fatigue/*`) protects a room where
machine traffic runs away: two agents sharing a room and answering each
other in a loop. With one companion and its human, that condition cannot
arise. Fatigue comes back per deployment, when a deployment puts two agents
in one room. It comes back from the donor files at e6a9546, as recorded in
the 3.17 fatigue rows of `cuts.tsv` (rows 58-63), not as a new design.
There is no code change in this step.

### E6: model usage stays in memory

Decided (operator ruling, item 6): the host's model-usage recorder stays in
memory. `apps/standalone/src/model-usage.ts` keeps the totals of calls,
failures, tokens and effective cost by runtime lane and by provider/model
(`LiteRuntime.modelUsage()`), as "Review fixes after Step D" (finding 1)
describes. The totals are lost at a restart. The donor's durable
model-usage ledger, its budget store, the budget threshold alerts and the
exports stay cut (B7 charge, 3.11 operator-alerts). The recorder exists so
the donor `LLMClient` accountability guard admits the autonomous lanes.
This is the decided design, not an open item. There is no code change in
this step.

Step E result (the plain validation command with a JSON reporter, both
projects): 774 files and 9,190 tests passed. `compare-baseline.mjs`:
"baseline: 807 files / 10107 tests; deleted: 54 files, 1041 tests; matched:
9066; Lite additions: 4 files, 27 tests" and "equivalent: every remaining
baseline test has its baseline status". The Hermes plugin suite: 69 passed.

## Shakedown fixes (2026-11-09, Lite with Hermes, round r1)

The round (`lite-hermes-artie-20261109-r1`, evidence outside the
repository) found four Lite defects and one out-of-scope case. No donor
file changed; the `cuts.tsv` rows `S1` to `S4` record the host-side
changes. `S5` restores the donor's embedding providers, a divergence
found after the round, and supersedes `S1`.

### Embedding provider required

Superseded by "Donor embedding providers restored" below (seam `S5`): the
donor had no `disabled` kind, so Lite no longer offers one, and the
refusal, `EMBEDDING_PROVIDER_REQUIRED` and its guard are deleted. The
record as made:

`serve` with `embedding.provider: disabled` failed at the donor's startup
warmup ("embedding provider startup warmup failed",
`app/agent/companion-runtime.ts:572`, `app/startup/support/ml-warmup.ts:62-79`,
`faculties/memory/embedding.ts:560`). Every test passed
`overrides.embeddings`, so none reached the path.

Root cause: the core needs an embedding provider, and the donor never
started without one. Donor `resolveEmbeddingProviderKind`
(`src/faculties/memory/embedding.ts:564-569`) throws "embeddingProvider is
required in settings.json; startup no longer defaults embeddings", its
warmup fails startup on any error (`docs/memory/l2-typed.md`, "Fail-closed
warmup"), and memory writes embed or throw. Lite's disabled port
(`packages/pi/src/embeddings.ts`) answers "unavailable" to every call, so
the donor's warmup refused it as it would refuse a broken provider.

Fix, and a deliberate divergence from "a disabled provider must not fail
startup": making it start would invent a no-embedding core the donor never
had (writes without vectors, recall without search). Instead the
standalone refuses `disabled` by name before any database, model or
classifier work (`apps/standalone/src/runtime.ts:69`
`EMBEDDING_PROVIDER_REQUIRED`, `buildEmbeddings` `:127-130`, called first at
`:150`), unless the host passes its own embedding port
(`overrides.embeddings`). `embedding.provider.kind` must be
`openai_compatible` for a standalone deployment. Guard:
`tests/standalone/embedding-required.test.ts` runs the real
`main.ts serve` with `disabled`, no overrides and a database nothing
listens on: exit status 1, stderr names the requirement and never the
warmup.

### Model cache under the data directory

The first `serve` of the round downloaded the 478 MB text-emotion model
into the source checkout (`<worktree>/models/transformers/`). Root cause:
the donor's seeded `settings.json` value is relative
(`config/settings.seed.json` `"textEmotionCacheDir": "models/transformers"`),
Lite copied it into the substrate config as is, and the classifier hands it
to transformers' `env.cacheDir`, which resolves it against the working
directory. The donor ran from its repository root, with `/models/`
gitignored (donor `.gitignore:138`). Fix: `textEmotionCacheDir` stays the
owner's `settings.json` value, but a relative value, and a missing one
(the donor default `models/transformers`), resolves under `dataDir`
(`apps/standalone/src/substrate-config.ts:117-150`); an absolute value is
kept. `/models/` is gitignored at the repository root, as in the donor.
Guard: `tests/standalone/model-cache.test.ts` seeds a data directory with
the real `init` and builds the substrate config as the runtime does.

### The explicit tool contract reaches the host

Four turns of the round failed as `tool_contract_incompatible`
(contact_sessions, focus_cycle, tool_discovery, the restore turn of
memory_delete_restore). Root cause: the donor's provider client forced the
tool choice of every model call of a turn with an explicit tool request,
but `HostTurnContext` carried no tool choice, so Hermes's model chose
freely and the donor's stream adapter refused its answer.

Fix: the relay hands the host the donor's own contract per model call,
computed by the donor's `resolveExplicitToolContract` for
`agent.turn.prompt` (`packages/lifecycle/src/host-turns.ts:76-110`):
`{kind: "tool", name, parameters}` (with the donor's exact-arguments schema,
`buildExactToolArgumentsModelSchema`, when the participant gave the call's
arguments), `{kind: "none"}`, or null. `prepare`'s context carries the
first call's (`wire.ts` `renderToolChoice`); the bridge's `tool-choice`
route (`http.ts:159`, `bridge.ts:236`) answers it for the open turn's next
call, serialized with the host's tool calls (`HostTurn.toolChoice`,
`host-turns.ts:226`), only to the host instance that prepared the turn.
The Hermes plugin registers Hermes's `llm_request` middleware
(`integrations/hermes/psfn_lite/runtime.py` `_llm_request`, `Driver.llm_request`
in `lifecycle.py`, the rewrite in `toolchoice.py` `apply`), keeps the
prepared choice, asks `tool-choice` again after each Lite tool call, and
rewrites the provider request as the donor's provider client did. Its
limits are under "What a host-driven turn cannot reproduce". Guards:
`tests/lifecycle/tool-choice.test.ts` (the contract per call over the
donor's message shapes), `tests/lifecycle/host-turns.integration.test.ts`
(prepare and `tool-choice` over HTTP, owner checks, and a completed turn
that follows them), `integrations/hermes/tests/test_tool_choice.py`
(through Hermes's own `apply_llm_request_middleware`) and
`test_e2e_lite.py` (an explicit request against the real Lite, recorded as
completed). The test faux model reports `openai-completions` where the
contract is exercised (`tests/support/faux-model.ts` `FauxModelOptions`),
since the donor refuses explicit requests on other APIs.

### Hermes 2bd378e

At Hermes `2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19` (the operator's live
install), `hermes chat` runs through a gateway (`hermes_cli/gateway_chat.py`),
and one gateway serves several profiles. Root causes and fixes, all in the
plugin:

- The plugin kept one set of hooks, warning callbacks and handles per
  process (`runtime.py`, `_handles` by hook name). With a module shared by
  several homes (f0187332 names a user provider's module by its name only),
  a second profile's manager got no hooks. Everything is now keyed by the
  resolved home (`runtime.py` `_handles`, `_drivers`,
  `_warning_callbacks`, `register_hooks`), so each profile has its own
  hooks, driver, ledger and host instance.
- The fail-closed gate that blocks every MCP tool when `psfn-lite.json`
  cannot be read applied in any profile whose manager held the hooks. It
  now applies only where `memory.provider` is `psfn_lite`
  (`runtime.py` `_selected`); another profile is left alone.
- The bridge credential was read from `os.environ`; a gateway clears the
  inherited environment and loads each profile's `.env`. It is read through
  Hermes's `agent.secret_scope.get_secret` (`config.py` `Config.credential`),
  which fails closed without a profile scope under multiplexing.
- The install id is read through `hermes_cli/install_identity.py`
  `get_install_id` (one per install, shared by profiles; it mints once if
  missing). At f0187332, which has no such module, the file is read as
  before (`config.py` `hermes_install_id`).
- The gateway's CLI sender is `uid:<uid>` (`gateway/control_socket.py`
  `_posix_peer_subject`); the README says how to bind it. This record first
  gave the platform as `local`; round r2 showed it is `cli` (corrected
  under "Shakedown fixes, round r2", R2-1).
- `plugin.yaml` now lists `post_tool_call` and the `llm_request`
  middleware (`provides_middleware`); a test compares it with what the
  plugin registers.

The README documents that the credential belongs in the profile's `.env`
and that the root gateway adopts a new profile unless it sets
`gateway.standalone: true`. The suite runs at both revisions
(`HERMES_REVISIONS`, `docs/development.md`); 2bd378e from a clone of the
live install, never the install itself. `tests/test_profiles.py` runs two
Lite profiles and a non-Lite profile in one process under multiplexing.

Result (the plain validation command with a JSON reporter, both
projects): 777 files and 9,199 tests passed (`lite` 20 files / 106 tests,
`companion` 757 files / 9,093 tests). `compare-baseline.mjs`: "baseline:
807 files / 10107 tests; deleted: 54 files, 1041 tests; matched: 9066; Lite
additions: 4 files, 27 tests" and "equivalent: every remaining baseline
test has its baseline status". The Hermes plugin suite: 80 passed and 1
skipped at f0187332 (the 2bd378e install-identity test), 79 passed and 2
skipped at 2bd378e (the two f0187332 install-id file tests). No test
container or `/tmp/lc-*` directory was left.

### capability_refusal_matrix is out of scope

Decided (no code): the donor harness case `capability_refusal_matrix` is
out of scope for Lite shakedowns. It dispatches only with dedicated real
external sinks (`PSFN_MATRIX_EXTERNAL_SINKS_CONFIRMED=dedicated-test-sinks`,
a dedicated Discord snowflake and an email target; donor
`shakedown/harness/lib/capability-matrix.mjs:327-344`), and the surfaces it
sends through (`notify`, the Discord and email sinks) are cut
(`docs/tool-inventory.md`, "Donor surfaces Lite does not serve"). The
donor never had it green either.

### Donor embedding providers restored

Lite's config offered only `embedding.provider` `disabled` and
`openai_compatible`, a Lite adapter over `<baseUrl>/embeddings`
(`packages/pi/src/embeddings.ts`, deleted). The donor offered `ollama`,
`transformers` and `api` (`src/faculties/memory/embedding.ts:29`,
`resolveEmbeddingProviderKind` `:564-579`, `createEmbeddingProviderFromConfig`
`:721-734`), and its seeded `settings.json` chose `transformers`, the local,
keyless provider over `@huggingface/transformers` 4.2.0
(`config/settings.seed.json:499-508`: `embeddingProvider` `transformers`,
`transformersModel` `Xenova/all-MiniLM-L6-v2`, `embeddingDims` 384). Dropping
those kinds was a divergence, not a scaffolding cut. Seam `S5` restores
them through the donor's own provider classes; no donor file changed.

- The config's `embedding.provider.kind` is one of the donor kinds
  (`apps/standalone/src/config.ts:48-71`, `EMBEDDING_PROVIDER_KINDS` `:182`,
  `parseEmbedding` `:239-278`): `{kind: "transformers", cacheDir?}`,
  `{kind: "ollama", url}` or `{kind: "api", url, apiKeyEnv}`, with
  `embedding.model` and `embedding.dimensions`. Without an `embedding`
  block the donor's seeded default applies (the values of
  `DEFAULT_TRANSFORMERS_EMBEDDING_CONFIG`), so a Lite install runs without
  any API key. `disabled`, `openai_compatible`, `baseUrl` and `timeoutMs`
  are refused when the config is read.
- `buildSubstrateConfig` sets the donor fields each kind reads
  (`substrate-config.ts` `embeddingSettings`): `embeddingProvider`,
  `embeddingModel` and `embeddingDims` for every kind (so no seeded
  `settings.json` value of another kind, such as `embeddingApiModel`
  `snowflake-arctic-embed2` / 1024, decides anything), plus
  `transformersModel` and `transformersCacheDir`, `embeddingOllamaUrl`, or
  `embeddingApiUrl`, `embeddingApiModel`, `embeddingApiDims` and
  `embeddingApiKeyRef`. The donor read these from `settings.json`; a Lite
  host names its provider in its config, as it does its model.
- The standalone passes no embedding provider unless the caller supplies
  a port (`runtime.ts` `hostEmbeddingProvider`), so the donor composition
  builds its own (`provider-runtime-factory.ts`:
  `options.embeddingProvider ?? createEmbeddingProviderFromConfig(config,
  env)`), wraps it in its usage accounting and checks it with its
  fail-closed warmup. The `EmbeddingPort` seam (`companionEmbeddingProviderOf`)
  stays for a host with its own vectors (the tests' deterministic port).
- Model cache: the donor cached the model at
  `resolveProjectTransformersCacheDir(process.cwd())`
  (`<cwd>/models/transformers`, `embedding.ts:99-103`); Lite passes
  `resolveProjectTransformersCacheDir(dataDir)`, the directory the
  text-emotion model uses after `S2`, and resolves a relative `cacheDir`
  under `dataDir`. It is always absolute, so the donor's CWD fallback never
  applies.
- `openai_compatible` maps onto the donor `api` provider
  (`ApiEmbeddingProvider`, `embedding.ts:403`), not onto Lite's adapter:
  that adapter was never the donor port, only a Lite `EmbeddingPort` behind
  `companionEmbeddingProviderOf`, and it lacked the donor's usage and cost
  extraction. Behaviour that changes with it: `url` is the full endpoint
  (the donor posts to it as given), the request carries no `dimensions`
  field and no client timeout, and the key comes from the variable
  `apiKeyEnv` names (the donor's own `embeddingApiKeyRef`, `embedding.ts:48`,
  `:704-708`), else the donor's `EMBEDDING_API_KEY`, then `OPENAI_API_KEY`;
  with neither the request is sent without a key. `readSecrets` still
  names a missing `apiKeyEnv` variable at start.
- `S1` (the `disabled` refusal) is superseded and removed with its guard.

Guards: `tests/standalone/embedding-providers.test.ts` builds each kind
through the real `parseLiteConfig`, `buildSubstrateConfig` and the donor's
`createEmbeddingProviderFromConfig`: the donor class, its provenance and,
for `ollama` and `api`, the request it sends to a loopback endpoint; the
default's values are compared with the shipped seed.
`tests/standalone/transformers-embeddings.integration.test.ts` starts a real
runtime with no embedding block and no host port: the donor transformers
provider downloads the model into `<dataDir>/models/transformers`
(91,100,283 bytes; nothing in the working directory), passes the startup
warmup, and the memory a turn writes is stored with a 384-dimension unit
vector, every embedding call accounted to
`transformers/Xenova/all-MiniLM-L6-v2`. `LITE_TEST_TRANSFORMERS_CACHE`
copies an existing cache in instead of downloading. The named key's
reference reaches the donor factory unchanged: `startCompanionRuntime`
assigns only the inner-life policy keys over the config
(`companion-runtime.ts` `applyInnerLifeConfig`) before
`createProviderRuntimeServices`, and `sanitizeCoreSubstrateConfig` removes
only its listed secret-bearing keys, not `embeddingApiKeyRef`.

Result (the plain validation command with a JSON reporter, both
projects): 778 files and 9,201 tests, 9,200 passed (`lite` 21 files / 108
tests, `companion` 757 files / 9,093 tests). The one failure was the
transformers boot test: the model download into the temporary data
directory hit the workstation's `/tmp` tmpfs user quota (`usrquota`,
"Unknown system error -122", `EDQUOT`) while 16 workers ran; the file
passed on its own before and after that run, on the same code.
`compare-baseline.mjs`: "baseline: 807 files / 10107 tests; deleted: 54
files, 1041 tests; matched: 9066; Lite additions: 4 files, 27 tests" and
"equivalent: every remaining baseline test has its baseline status". The
Hermes plugin suite: 80 passed and 1 skipped at f0187332, 79 passed and 2
skipped at 2bd378e. No test container or temporary data directory was left.

## Shakedown fixes (2026-11-09, Lite with Hermes, round r2)

Round `lite-hermes-artie-20261109-r2` ran Lite at `a0dd368` with the live
Hermes `2bd378e` (evidence outside the repository: its `ROUND-NOTES.md` and
`comparison-table.md`). S3 did not take effect there: 18 of 23 harness cases
were ok. Four findings, all in the Hermes plugin; no donor file and no Lite
TypeScript changed. The `cuts.tsv` row `S6` records them and amends `S3`
and `S4`.

### R2-2: Tool Search hid the Lite tools

At 2bd378e Tool Search is on by default (`hermes_cli/config_defaults.py`
`tools.tool_search.enabled: "auto"`, :1969-1985). It defers every tool
that is not core and whose toolset starts with `mcp-` or is not a direct
surface (`tools/tool_search.py` `is_deferrable_tool_name`, :150-162), and
`assemble_tool_defs` (:344-379) replaces them with the `tool_search`,
`tool_describe` and `tool_call` bridges. So `mcp__psfn_lite__*` was not in
the provider request, `toolchoice.py` raised "not offered" 48 times, and
the requests went out unforced (contact_sessions, prompt_stack and
tool_discovery failed as before). The donor's model always saw its core
tools directly.

Root cause: Hermes has no supported way to keep an MCP or plugin tool
eager. `defer` only adds tools to the deferred set
(`ToolSearchConfig.effective_defer_tools`); `PluginContext.register_tool`
(`hermes_cli/plugins.py:463`) and `registry.register`
(`tools/registry.py:735`) take no flag; the only bypass,
`skip_tool_search_assembly` in `model_tools._compute_tool_definitions`
(:513-554, the bypass at :543), is internal. (The user guide says `defer: []` keeps every tool
eager; the code still defers MCP and plugin tools.) Turning Tool Search off
globally is not required.

Fix: a forced step for a deferred Lite tool goes through the `tool_call`
bridge. When the requested tool is not in the request but `tool_call` is,
`toolchoice.apply` (`integrations/hermes/psfn_lite/toolchoice.py:180-212`,
the branch at :198-206) offers only that bridge, with
`tool_choice: "required"` and parallel calls off, its schema narrowed by
`_one_call_bridge` (:148-177): exactly one call
(`minItems`/`maxItems` 1 in 2bd378e's `{calls: [...]}` form; the single
`{name, arguments}` form at f0187332), `name` an enum of the Lite tool
alone, and `arguments` the tool's own schema from Hermes's registry
(`registered_tool`, :125-138, the lookup Hermes's own validator uses) or
the donor's exact-arguments schema. Hermes unwraps the call before its
hooks, approvals and dispatch (`agent/tool_executor.py`
`_unwrap_tool_search_call`, :389-432; `model_tools.py` :745-765), so the
plugin's `pre_tool_call` gate and `post_tool_call` (which asks Lite for the
next step) see `mcp__psfn_lite__<tool>`. An eager Lite tool (Tool Search
off) is forced directly as before; neither present is still reported.

### R2-3: the "no more tools" step kept the tools

The plugin kept the tools with `tool_choice: "none"`; DeepSeek then wrote
the call it wanted as text, which became the reply (north_star_cycle,
memory_write_patch, the memory_delete_restore restore turn). The donor
removes the tools (`client-request-capability.ts` `buildPiContext`,
:238-240: `choice === 'none'` sets `tools = undefined`). Fix: a `none` step
removes `tools`, `tool_choice` and `parallel_tool_calls` in every API mode
(`toolchoice.py:185-189`). Hermes's own Anthropic mapping of `none` does
the same (`agent/anthropic_adapter.py:682-683`).

### R2-4: DeepSeek refuses a forced choice while thinking

With Tool Search off (the round's diagnostic run), every forced step failed
with DeepSeek HTTP 400 "Thinking mode does not support this tool_choice".
Hermes's DeepSeek profile always sends the thinking toggle for
`deepseek-v4*` and `deepseek-flash`
(`plugins/model-providers/deepseek/__init__.py`, `extra_body.thinking`
plus a top-level `reasoning_effort` from `agent/reasoning_effort.py`
`thinking_toggle_extras`, :229-251). The plugin stripped thinking only for
Anthropic; the donor disabled it for required tools only on Kimi Code
(`primitives/llm/models.ts:61-67`, applied in `applyExplicitToolChoice`
:268-280: delete reasoning, send `thinking: {type: "disabled"}`).

Fix: the donor's quirk as a provider capability.
`FORCED_CHOICE_WITHOUT_THINKING` (`toolchoice.py:46-58`) lists DeepSeek and
Kimi by Hermes provider id and host (the hosts Hermes itself treats as
those vendors, `agent/message_sanitization.py` `_REASONING_ECHO_RULES`);
`thinking_family` (:101-111) also returns `anthropic` for the Messages API.
On a forced request only, `_without_thinking` (:114-122) sets
`extra_body.thinking` to `{"type": "disabled"}` and drops
`reasoning_effort` (Hermes's own disabled form, `thinking_toggle_extras`
:245-246), or drops Anthropic's `thinking`. The middleware gets the
provider and base URL from Hermes's call (`agent/turn_api_request.py:158-162`;
`Driver.llm_request`, `lifecycle.py:294`, :316). The next, unforced
request keeps Hermes's thinking fields. The donor TypeScript is unchanged:
Lite's own model calls already follow it.

### R2-1: the CLI sender binds as platform `cli`

The README and `config.py` said the gateway's CLI sender is
`{"platform": "local", "sender_id": "uid:<uid>"}`, and
`tests/test_profiles.py` bound it that way by hand. At 2bd378e the gateway
maps its `Platform.LOCAL` source to `cli` before the agent and its hooks
run (`gateway/run_turn_runner.py:1253`, :1270 `platform_key`; a local
session policy gives `SURFACES["cli"]`, also `cli`), so Lite logged
`unbound_sender: platform 'cli'`. Fix: `config.py:40-43` and the README
give `{"platform": "cli", "sender_id": "uid:<uid>"}` and name the other
local surfaces' platforms (`tui`, `desktop`), untested here.
`tests/test_profiles.py` now takes the pair from Hermes's own code
(`cli_sender`, :45-68): the `platform_key` assignment parsed out of
`TurnRunner._run_sync_scoped` and evaluated for a `Platform.LOCAL` source
(`gateway_platform_key`, :29-42), and the sender from
`GatewayControlServer._posix_peer_subject` over a real Unix socket pair.

### Guards

- `integrations/hermes/tests/test_tool_search_wire.py` runs a real
  `AIAgent.run_conversation` with Tool Search at its default (asserted
  `auto`), the Lite tool registered as Hermes's MCP client registers it
  (toolset `mcp-psfn_lite`), Hermes's DeepSeek provider (`deepseek-flash`)
  and the plugin loaded, against a loopback chat-completions server that
  records each request body as it arrives over HTTP. An unforced turn shows
  what r2 saw (the bridges, no Lite tool, thinking on). An explicit turn
  shows the forced request with only the narrowed `tool_call`, `required`,
  `thinking: {"type": "disabled"}` and no `reasoning_effort` (own schema
  and exact-arguments variants); the Lite tool runs with the model's
  arguments and Lite is asked for the next step once; the next request
  carries no `tools`, `tool_choice` or `parallel_tool_calls` and thinks
  again; the turn settles with the reply. It runs at both revisions.
- `tests/test_tool_choice.py`: the `none` step without tools in all three
  API modes; thinking off on a forced step for DeepSeek and Kimi requests
  built by Hermes's own provider profiles (and by host), restored on the
  next step, and left alone for an aggregator; the bridge narrowed in each
  API mode and in both bridge forms.
- `tests/test_profiles.py`: the CLI pair from the gateway's own mapping.

## Measured size

After B7 (`packages/companion`, without `node_modules`):

| Part | Files | LOC |
|---|---:|---:|
| Core non-test TypeScript (closure, promoted files and Lite additions) | 1,189 | 335,123 |
| Tests | 682 | 255,893 |
| Test-support | 22 | 7,084 |
| Non-TS assets under `src/` | 23 | 1,633 |
| Seed config (`config/`) | 8 | 1,539 |
| Extraction records (`extraction/`) | 12 | 4,704 |
| Package files (`package.json`, configs, README, baseline) | 7 | 1,109 |

The deleted vendored set was 760 files and 230,765 LOC.

After Step D and the review fixes (the same parts, from the Git blobs at
the fix commit):

| Part | Files | LOC |
|---|---:|---:|
| Core non-test TypeScript | 1,190 | 335,809 |
| Tests (with the 71 kept promoted donor test files) | 756 | 279,078 |
| Test-support | 23 | 7,170 |
| Non-TS assets under `src/` | 23 | 1,633 |
| Seed config (`config/`) | 8 | 1,539 |
| Extraction records (`extraction/`, with `provenance-tables.py`) | 13 | 5,025 |
| Package files (`package.json`, configs, README, baseline) | 7 | 46,503 |

`baseline.json` alone is 46,308 lines (one row per donor test, 10,107 of
them). Test-support counts `src/test-support/` plus the
`*.test-support.ts` and `*.test-fixtures.ts` helpers, as the B7 table did.

After Step C, Lite's own code (lines of tracked `.ts`, `.py`, `.mjs`,
`.json`, `.yaml` and `.sql` files). `packages/companion` changed only by
seam C (`companion-runtime.ts`, 15 lines) and the boot test's import:

| Part | Before C (files / lines) | After C (files / lines) |
|---|---:|---:|
| `packages/core/src` | 124 / 15,295 | deleted |
| `packages/adapters/src` | 32 / 4,300 | deleted |
| `packages/lifecycle/src` | 6 / 746 | 8 / 1,109 |
| `packages/mcp/src` | 18 / 1,389 | 7 / 565 |
| `packages/pi/src` | 14 / 1,537 | 5 / 329 |
| `apps/standalone/src` | 16 / 1,526 | 10 / 1,030 |
| `integrations/hermes/psfn_lite` | 12 / 1,312 | 11 / 1,157 |
| `integrations/hermes/tests` | 7 / 1,630 | 7 / 1,464 |
| `tests` (with the scenario JSON) | 93 / 14,874 | 36 / 3,284 |
| `scripts` | 5 / 500 | 2 / 158 |

Without docs and Markdown, the Step C diff from `4a6bcf8` is 346 files,
+3,652 / -38,646 lines. The lockfile accounts for 975 of the deleted lines.

After Step D and the review fixes (the same measure; parts not listed are
unchanged since Step C): `packages/lifecycle/src` 8 / 1,300,
`apps/standalone/src` 11 / 1,153 (with `model-usage.ts`),
`integrations/hermes/psfn_lite` 13 / 1,688, `integrations/hermes/tests`
8 / 1,767, `tests` 39 / 3,484.
