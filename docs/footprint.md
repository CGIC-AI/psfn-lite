# Footprint

Measured Lite footprint, compared with a documented donor configuration
where a comparison could be measured. These are measurements on one
machine, not performance promises.

## Setup

| | |
|---|---|
| Date | 2026-11-08 |
| Machine | AMD Ryzen 9 7950X3D (16 cores, 32 threads), 124 GiB RAM, Linux 7.2.8 |
| Toolchain | Node 24.22.1 and npm 11.17.0 (`mise exec node@24.22.1 npm@11.17.0`), Docker 29.9.2, pgvector test image as pinned in `tests/support/postgres-harness.ts` |
| Lite | branch `test/conformance`, based on `main` at `9af7b98` |
| Donor | `psfn-framework` at `e6a9546051f4e92bf7218b133b4523ac53a797c0`. Measured in a throwaway clone (`git clone --no-checkout`, `git checkout <rev>`, `npm ci` with the donor's pinned toolchain, which is the same Node 24.22.1 and npm 11.17.0). The donor working tree was not touched. |

Scripts (run with tsx; the last two need Docker):

```bash
npx tsx scripts/bench/footprint.ts --project . --project <donor clone>
npx tsx scripts/bench/inference.ts
npx tsx scripts/bench/latency.ts
```

## Dependency and install footprint

`scripts/bench/footprint.ts`, on each project's install of its own lockfile: the donor clone's fresh `npm ci`, and the Lite worktree's existing install. It reads
package.json, package-lock.json and the installed node_modules (no symlinks
followed). It counts a package wherever a package.json sits directly under a
node_modules entry, nested ones included.

| | Lite | Donor |
|---|---:|---:|
| direct dependencies (prod / dev / optional) | 4 / 10 / 0 | 23 / 13 / 1 |
| lockfile entries | 365 | 564 |
| of which a production install keeps | 114 | 331 |
| installed packages under node_modules | 271 | 465 |
| files under node_modules | 22,497 | 35,931 |
| node_modules apparent size | 205.3 MiB | 782.2 MiB |
| node_modules allocated on disk | 267.9 MiB | 882.4 MiB |
| own non-test TypeScript files | 206 | 2,513 |
| own non-test TypeScript lines | 24,364 | 725,449 |

Cross-checks: `du -sh --apparent-size` gives 195M and 772M, and
`npm ls --all --omit=dev --parseable` lists 115 and 282 lines. `npm ls`
lists what is installed, while the lockfile's production count also holds
platform-optional entries that a Linux x64 install skips.

Lite's four runtime dependencies are `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai`, `@modelcontextprotocol/server` and `pg`. The donor's
23 add, among others, Discord (discord.js, `@discordjs/voice`,
`@snazzah/davey`, prism-media, opusscript), `@redis/client`,
`@huggingface/transformers` (with onnxruntime), pdfjs-dist, winston, ws and
undici. `tests/conformance/absence.test.ts` keeps them out of Lite.

Notes:

- Lockfile entries exceed installed packages because a lockfile lists
  platform-specific optional packages (esbuild, rollup and others) that a
  Linux x64 install skips.
- npm 11 did not run the donor's install scripts (`allow-scripts`:
  onnxruntime-node, esbuild, protobufjs, `@google/genai`). The donor sizes
  are therefore without anything those scripts would download.
- The donor's secondary installs are not included: `apps/satellite-hub` and
  `tools/evals` have their own lockfiles.
- Source roots are `packages`, `apps` and `integrations` for Lite, and `src`,
  `apps` and `integrations` for the donor. Test files (`*.test.ts`,
  `*.spec.ts`, `test`, `tests` and `test-support` directories) are excluded.
  The donor keeps its 1,776 test files (631,534 lines) beside its source.
  Lite keeps its tests under `tests/`, outside these roots.
- Install time is not reported. The donor's `npm ci` came from a warm npm
  cache in about 4 s, and Lite's install was already there.

## Idle inference

`scripts/bench/inference.ts`. Lite is the real standalone runtime over
Postgres. It runs one-minute scheduler ticks over a simulated day (1,440
ticks) under the baseline policies, and nobody talks to it. The scripted
model counts every provider request by kind. A "companion" request is the
companion's own turn. "estimator" and "inference" are the machine emotion
estimate and appraisal made when a turn settles.

| Lite, one idle day | companion | estimator | inference | total | ticks that made a call |
|---|---:|---:|---:|---:|---:|
| every invitation answered with rest (4 blocks rested) | 8 | 4 | 4 | 16 | 8 of 1,440 |
| every invitation answered with a reflection (6 blocks) | 18 | 12 | 17 | 47 | 9 of 1,440 |
| every invitation ignored (6 blocks lapsed) | 6 | 6 | 6 | 18 | 9 of 1,440 |
| a tick with nothing due (resting, outside quiet hours, minimum interval, daily cap) | 0 | 0 | 0 | 0 | — |

The only model calls an idle Lite makes are free-time invitations, and only
when the policy makes one due: quiet hours 01:00–06:00 UTC, a minimum
interval of 180 minutes, at most 3 blocks a day per lane, 30 minutes of
partner quiet and 360 minutes of rest after a rest decision. Every other tick
makes no call. Memory maintenance also runs every 10 ticks. On the
reflection day it made 6 of the 17 inference calls, memory extraction over
the self sessions the reflections left. The other 11 were appraisals. It made
none on the other two days.

The donor configuration: its idle-purity certification
(`npm run verify:idle-purity`, `src/app/e2e/idle-purity-certification`). It
boots the production agent (`src/app/agent/main.ts`) with the Gateway, its
enabled automata (background maintenance, both free-time lanes, the
morning temporal wakeup and weighted-thought outreach) and an ICP
single-companion fixture. A counting OpenAI-compatible fixture server stands
in for the provider. After a 65 s warmup and a 60 s idle window with no work
due, it asserts zero model requests and no durable churn. In the throwaway
clone it passed twice (6/6 tests, 156–160 s each). Donor and Lite both make
**zero model calls when nothing is due**.

Not measured: a donor idle **day**. The donor certification uses real time
and asserts only a no-work-due window. Simulating a day of its scheduler
lanes would need a clock seam and fixtures the donor does not have at this
revision, so the per-day rows above have no donor column.

## Per-workload model calls (Lite)

Same script, one runtime, in order:

| workload | companion | estimator | inference | worker | total |
|---|---:|---:|---:|---:|---:|
| participant turn, no tool calls | 1 | 1 | 0 | 0 | 2 |
| participant turn, 3 tool calls | 4 | 1 | 1 | 0 | 6 |
| participant turn spawning a worker (2 worker tool calls) | 2 | 1 | 0 | 3 | 6 |
| maintenance after the conversation ended (3 turns, nothing extracted) | 0 | 0 | 2 | 0 | 2 |
| maintenance with nothing new | 0 | 0 | 0 | 0 | 0 |
| one free-time block, reflection chosen | 3 | 2 | 1 | 0 | 6 |
| one free-time block, rest chosen | 2 | 1 | 1 | 0 | 4 |
| tick while resting | 0 | 0 | 0 | 0 | 0 |

A companion turn costs one request per tool round plus the reply. The worker
used one request per tool call plus its result. The appraisal ran on
settlement for the turns that made tool calls and for the free-time turns,
and not for the plain message.

Not measured for the donor. Its turn path runs through the Gateway,
SubstrateAgent and the channel pipeline. At `e6a9546` it has no
harness that counts provider requests per turn, and building one would
mean changing the donor. A donor column would be an estimate, so there is
none.

## Turn latency and memory (Lite)

`scripts/bench/latency.ts`. The scripted model answers at once, so these
numbers are Lite's own overhead per turn: Postgres, the JSONL archive,
context assembly, governed dispatch and the post-turn emotion estimate. They
are not a provider's latency. There were 5 warmup turns, then 100 plain
turns, 20 turns with 3 tool calls (memory write and search, session
messages) and 50 idle ticks.

| | p50 | p95 | max |
|---|---:|---:|---:|
| participant turn, no tool calls | 5.0 ms | 6.5 ms | 7.9 ms |
| participant turn, 3 tool calls | 7.9 ms | 15.3 ms | 15.3 ms |
| idle scheduler tick | 2.2 ms | 4.0 ms | 8.7 ms |

| Resident set (RSS) | Lite | Donor |
|---|---:|---:|
| runtime process idle, nothing due | 147 MiB after open, 156 MiB max over 30 s | 450 MiB at start, about 897 MiB plateau (899 MiB max) over the idle window |

Lite's figure is the conformance host process: node with tsx's loader, the
standalone runtime, the MCP transport, the lifecycle bridge and the scripted
model, sampled from `/proc` once a second. The donor's figure is its
production agent process during the idle-purity run, sampled with `ps` every
2 s (76 samples): node with tsx's loader, the agent, its Gateway and enabled
automata. Both are idle with nothing due. Neither is a production build.

In-process, the benchmark also reports Lite's runtime open at about 1.9 s
(migrations included), a heap of about 65 MiB after 125 turns, and process
RSS rising from 163 MiB at open to 197 MiB after those turns. That RSS
includes the benchmark and the Postgres harness client.

## Limitations

- One machine and one run of each. Latency figures vary by a few
  milliseconds between runs. They show orders of magnitude, not budgets.
- A scripted model makes every call. Real providers add their own latency,
  and their responses change how many tool rounds a turn takes.
- Lite figures come from the conformance host, which includes the scripted
  model. Donor figures come from its own certification harness. Both run
  under tsx, not from a build.
- Not measured, as stated above: donor per-workload calls, a donor idle
  day, donor turn latency, and both install times.
