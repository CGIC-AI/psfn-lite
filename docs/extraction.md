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
| B5c: `system/capabilities/runtime.test.ts` (4), `system/config/{capability-tier-config,capability-tier-per-companion,charge-policy-config,charge-policy-per-companion}.test.ts` (5, 8, 16, 6), `subsystem-config.test.ts` "round-trips capability-tier.json without drift" | Their subjects are now `cut` (charge and tiers are stubs). | 3.17 charge, tiers |
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
| 3.17 fatigue / participation | Type copy only what `shared/event-bus.ts` and three core sites need: `shared/contracts/participation-types.ts` (`core/participation/types.ts:11-26,95-141,154-156,186-197`) and `shared/contracts/fatigue-event-types.ts` (`human-attention-pressure.ts:7-41`, `room-episode-circuit-breaker.ts:50-64,77-78,80-102`, `social-pot-enforcement.ts:54-62`). Delete call path: the fatigue ports (`fatigueBudget`, `humanAttentionPressure`, `fatigueRegulationReservations`), the evaluation, reservation, spend, finalize and release blocks in `turn-execution-runtime.ts`, and the two alerts in `prompt-assembly.ts`. Stub: the ICP recovery codec marks `fatigue` and `fatiguePendingSpend` `excluded`. 15 files `cut` (`core/agent/fatigue/*` in the closure, `icp-fatigue-regulation.ts`, `core/participation/types.ts`, `icp-recovery-fatigue-{binding,metadata}.ts`). | A turn runs the donor's no-port path: no budget, no MI-turn suppression or overcharge, no `agent.fatigue` events, no fatigue or human-attention prompt alerts (both builders return `''` without their ports). A recorded ICP recovery response that carries fatigue metadata is rejected with `<label> contains unknown fields: fatigue, fatiguePendingSpend` (the donor parsed and bound it); Lite never records one. |
| 3.17 charge | Stub (inert mode): nothing in the core loads `charge-policy.json`, so `SubstrateConfig.chargePolicy` stays undefined and every core caller takes its donor no-policy branch (`substrate-agent.ts:1944`, `moa-turn.ts:213,432-433`, `run-charge.ts:376-378,443-447,520-523`, `runtime-context-sections/charge.ts:61-69`). `run-charge.ts`, the `charge-policy.ts` contract and the charge prompt section stay core, unchanged. Redirect the three type imports to the contract; delete call path: the durable charge recorder/probe (their only reader was `icp-fatigue-regulation.ts`). `charge-policy-config.ts` is `cut`. | No run-charge quotas, no `Charge quota exceeded` errors, no `agent.charge` events; the charge prompt variables report no budget. The donor seed set quotas per lane (interactive 24, companion_social 24, background 16, maintenance 0, subagent 6, shard 12). A host that sets `config.chargePolicy` itself still gets the donor behaviour. |
| 3.17 capability tiers | Delete call path: `CapabilityRuntime` (the per-refresh `capability-tier.json` reader) and `setCapabilityRuntime` in `substrate-agent.ts`. `tier-types.ts` and `tiers.ts` stay core; the tier comes from an injected `CapabilityAccess` or `config.capabilityTier` via `normalizeCapabilityTier`, fallback `nursery` (`tiers.ts:88-93`), the donor seed's tier (`capability-tier.seed.json`: `{"tier": "nursery", "customTokens": []}`). `system/capabilities/runtime.ts` and `capability-tier-config.ts` are `cut`. | The tier is fixed by the host; owner edits to `capability-tier.json` (and its `custom` token list) are no longer read. |
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
| 3.1 provider | `createProviderRuntimeServices` keeps the donor no-model-usage-store branch and takes an optional host `embeddingProvider`. Host adapters in `packages/pi`: `companionProviderRuntimeOf` (a structural `ProviderRuntime` over one `PiModelRuntime`), `companionModelRegistryEntryOf` (one `models.json` registry entry routing the donor's single-model purposes to the host model) and `companionEmbeddingProviderOf` (a donor `EmbeddingRuntimeProvider` over a Lite `EmbeddingPort`). The in-process `LLMProviderPort` is the donor's own `LLMClient`. | No model-usage ledger or embedding usage accounting. The host model and key serve every purpose. |
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
   eligibility gate and the persistence runtime.
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
- **Continuity channels.** No continuity channel ids by default. The donor
  read them from `channels.json`.
- **Memory deletion.** Without a host approval port, the companion's memory
  delete action returns the donor's "not configured" error.
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
core loaders read stay. The rows stay in `vendored-files.txt` as the record;
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
for Step C, not imports.

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
