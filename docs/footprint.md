# Footprint

This is Lite's measured install footprint after extraction Step C, compared
with the donor. These are measurements on one machine, not performance
promises.

## Setup

| | |
|---|---|
| Date | 2026-11-08 |
| Machine | AMD Ryzen 9 7950X3D (16 cores, 32 threads), 124 GiB RAM, Linux 7.2.8 |
| Toolchain | Node 24.22.1 and npm 11.17.0 (`mise exec node@24.22.1 npm@11.17.0`) |
| Lite | branch `feat/extract-core`, after extraction Step C |
| Donor | `psfn-framework` at `e6a9546051f4e92bf7218b133b4523ac53a797c0`, in a throwaway clone (`git clone --no-checkout`, `git checkout <rev>`, `npm ci` with the donor's pinned toolchain, which is the same Node 24.22.1 and npm 11.17.0). The donor working tree was not touched. |

```bash
npx tsx scripts/bench/footprint.ts --project . --project <donor clone>
```

## Dependency and install footprint

`scripts/bench/footprint.ts` reads package.json, package-lock.json and the
installed node_modules of each project's install of its own lockfile, with
no symlinks followed. A package is counted wherever a package.json sits
directly under a node_modules entry, nested ones included.

| | Lite | Donor |
|---|---:|---:|
| direct dependencies (prod / dev / optional) | 9 / 11 / 0 | 23 / 13 / 1 |
| lockfile entries | 444 | 564 |
| of which a production install keeps | 199 | 331 |
| installed packages under node_modules | 343 | 465 |
| files under node_modules | 26,276 | 35,932 |
| node_modules apparent size | 889.3 MiB | 782.2 MiB |
| node_modules allocated on disk | 962.4 MiB | 882.5 MiB |
| own non-test TypeScript files | 1,224 | 2,513 |
| own non-test TypeScript lines | 339,771 | 725,449 |

Lite's nine runtime dependencies are the companion core's eight, all at
exact donor versions: `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai`, `@huggingface/transformers`, `@sinclair/typebox`,
`js-tiktoken`, `pg`, `uuid` and `winston`. The ninth is
`@modelcontextprotocol/server` for the MCP transport. The donor's 23 add,
among others, Discord (discord.js, `@discordjs/voice`, `@snazzah/davey`,
prism-media, opusscript), `@redis/client`, pdfjs-dist, ws and undici.
`tests/conformance/absence.test.ts` keeps those out of Lite.

Notes:

- **Why Lite's node_modules is larger.** Lite's `onnxruntime-node` 1.24.3
  holds the CUDA and TensorRT execution providers
  (`bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so` and
  `..._tensorrt.so`, 302 MiB). Its install script downloads them on a
  machine with CUDA. The donor clone's install did not run that script:
  npm 11's `allow-scripts` held back onnxruntime-node, esbuild, protobufjs
  and `@google/genai` there. Without those two libraries, Lite's
  node_modules is about 588 MiB apparent, against the donor's 782 MiB.
- Lockfile entries exceed installed packages because a lockfile lists
  platform-specific optional packages (esbuild, rollup and others) that a
  Linux x64 install skips.
- Source roots are `src`, `packages`, `apps` and `integrations`. Test files
  (`*.test.ts`, `*.spec.ts`, `test`, `tests` and `test-support`
  directories) are excluded. Lite's figure is almost all the extracted core:
  the host adapters are 30 files and 3,033 lines (`packages/lifecycle`,
  `packages/mcp`, `packages/pi`, `apps/standalone`). The donor's figure
  leaves out one scratch file that an earlier measurement placed in the
  throwaway clone (`src/app/e2e/lite-bench-plain-turn.ts`).
- The donor's secondary installs are not included: `apps/satellite-hub` and
  `tools/evals` have their own lockfiles.
- Install time is not reported.

## Runtime measurements

Before Step C, this document also measured the idle inference, the model
calls per workload, the turn latency and the resident memory of Lite's own
runtime, using `scripts/bench/inference.ts` and `latency.ts`. That runtime
was deleted in Step C, and so were the benchmarks. Their figures describe
code that no longer exists, so they are not repeated here. They stay in the
history (`git show 4a6bcf8:docs/footprint.md`).

Lite's runtime is now the donor's companion core. The donor-side figures of
that earlier run were measured on the full donor with its Gateway:

- its idle-purity certification made zero model requests in a 60 s window
  with no work due;
- a plain participant turn in its walkthrough composition made one
  chat-model request and one embedding request;
- the idle production agent process was about 450 MiB RSS at start and
  plateaued near 897 MiB.

They were not re-measured on Lite after Step C. Not measured after Step C:
Lite's idle day, its model calls per workload, its turn latency and its RSS.
