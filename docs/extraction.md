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
| A path-preserving copy | Done: closure, selected tests, test-support and the temporarily vendored scaffolding; typechecks with the donor compiler options; the extracted tests reproduce the baseline. |
| B1-B7 seam cuts | Not started. No donor behaviour has been changed yet. |

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
- On this machine the test processes were repeatedly killed by an external
  `SIGKILL` (exit 137), sometimes the vitest main process (no report) and
  sometimes a worker ("Worker exited unexpectedly", its remaining tests left
  `pending`). It was not a test: a run with every JS-level `process.kill` and
  `ChildProcess.kill` logged showed none aimed at vitest; no OOM or
  systemd-oomd record; a same-process-group `sleep` and an idle or CPU-busy
  look-alike process survived; a 12 GB process tree survived. The cause was
  not found. Killed runs and killed workers are not test outcomes and are not
  counted; `baseline.json` lists the completed runs and their non-passed tests
  (all `pending` or hook timeouts, never an assertion failure, apart from the
  `TMPDIR` case above).

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

No donor test file was modified.

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

### Equivalence

`node packages/companion/extraction/compare-baseline.mjs <vitest json report>`
compares a run with `baseline.json` minus `extraction/deleted-tests.tsv`.

Step A result: every one of the 9,478 remaining baseline tests (9,485 minus the
7 card-importer tests) passed with its baseline status in the Lite run of the
`companion` project; the runs that did not match differed only by tests left
`pending` by an externally killed worker (see the baseline section).

## Deleted and modified tests

| Test | Reason | Seam |
|---|---|---|
| `src/core/identity/importer.test.ts` (7 tests) | Character card importer cut; `@character-foundry` not allowed | card importer, `core/identity/importer.ts:12` |

## Seam cuts

None yet (Step B). Each cut will be recorded here with file:line, cut type and
behaviour change.

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
