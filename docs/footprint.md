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

The Lite benchmarks run the real standalone runtime with two fakes, both
answering at once: the scripted model, which counts every chat-model
request by kind, and a counting embedding port. The embedding port stands in
for a configured OpenAI-compatible provider. It returns a deterministic
hashed bag-of-words vector in a 1,536-dimension space, so memory writes are
embedded when they are made and searches embed their query, as with a real
provider. Standalone without a provider (`embedding.provider.kind:
"disabled"`) makes no embedding requests and leaves writes pending. The
conformance suite runs that way.

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
model counts every chat-model request by kind. A "companion" request is the
companion's own turn. "estimator" and "inference" are the machine emotion
estimate and appraisal made when a turn settles. "embedding" counts requests
to the embedding port (see Setup).

| Lite, one idle day | companion | estimator | inference | model total | embedding | ticks that made a model call |
|---|---:|---:|---:|---:|---:|---:|
| every invitation answered with rest (4 blocks rested) | 8 | 4 | 4 | 16 | 4 | 8 of 1,440 |
| every invitation answered with a reflection (6 blocks) | 18 | 12 | 17 | 47 | 6 | 9 of 1,440 |
| every invitation ignored (6 blocks lapsed) | 6 | 6 | 6 | 18 | 6 | 9 of 1,440 |
| a tick with nothing due (resting, outside quiet hours, minimum interval, daily cap) | 0 | 0 | 0 | 0 | 0 | — |

The only model calls an idle Lite makes are free-time invitations, and only
when the policy makes one due: quiet hours 01:00–06:00 UTC, a minimum
interval of 180 minutes, at most 3 blocks a day per lane, 30 minutes of
partner quiet and 360 minutes of rest after a rest decision. Every other tick
makes no call. Memory maintenance also runs every 10 ticks. On the
reflection day it made 6 of the 17 inference calls, memory extraction over
the self sessions the reflections left. The other 11 were appraisals. It made
none on the other two days. Every idle-day embedding request was the
maintenance backfill (one request per maintenance run that found something
pending). It embedded the episodes that the free-time sessions left.

The donor configuration: its idle-purity certification
(`npm run verify:idle-purity`, `src/app/e2e/idle-purity-certification`). It
boots the production agent (`src/app/agent/main.ts`) with the Gateway, its
enabled automata (background maintenance, both free-time lanes, the
morning temporal wakeup and weighted-thought outreach) and an ICP
single-companion fixture. A counting OpenAI-compatible fixture server stands
in for the chat provider, and an in-process deterministic embedder stands in
for embeddings (`runtime-harness.ts`), as Lite's counting port does. After a 65 s warmup and a 60 s idle window with no work
due, it asserts zero model requests and no durable churn. In the throwaway
clone it passed twice (6/6 tests, 156–160 s each). Donor and Lite both make
**zero model calls when nothing is due**.

Not measured: a donor idle **day**. The donor certification uses real time
and asserts only a no-work-due window. Simulating a day of its scheduler
lanes would need a clock seam and fixtures the donor does not have at this
revision, so the per-day rows above have no donor column.

## Per-workload model calls

Lite, same script, one runtime, in order:

| workload | companion | estimator | inference | worker | model total | embedding |
|---|---:|---:|---:|---:|---:|---:|
| participant turn, no tool calls | 1 | 1 | 0 | 0 | 2 | 0 |
| participant turn, 3 tool calls (memory write, concern, activity) | 4 | 1 | 1 | 0 | 6 | 1 |
| participant turn spawning a worker (2 worker memory searches) | 2 | 1 | 0 | 3 | 6 | 2 |
| maintenance after the conversation ended (3 turns, nothing extracted) | 0 | 0 | 2 | 0 | 2 | 1 |
| maintenance with nothing new | 0 | 0 | 0 | 0 | 0 | 0 |
| one free-time block, reflection chosen | 3 | 2 | 1 | 0 | 6 | 0 |
| one free-time block, rest chosen | 2 | 1 | 1 | 0 | 4 | 0 |
| tick while resting | 0 | 0 | 0 | 0 | 0 | 0 |

A companion turn costs one request per tool round plus the reply. The worker
used one request per tool call plus its result. The appraisal ran on
settlement for the turns that made tool calls and for the free-time turns,
and not for the plain message. Each memory write and each memory search
made one embedding request (the write's content, the search's query), and
the maintenance after the conversation embedded one pending episode. A plain
turn made no embedding request: Lite does not retrieve memory by vector on
every turn.

Donor, plain participant turn (partly measured). The donor's process
harnesses at `e6a9546` already count provider requests. The idle-purity
certification boots `src/app/agent/main.ts`, and the ICP certification forks
its own certification agent process (`icp-certification/agent-process.ts`).
Both point the agent at a counting OpenAI-compatible fixture server and
read `modelRequestCount`. But they drive companion-to-companion ICP
exchanges and idle windows, and neither has a participant-turn command. The closest participant-turn path is
`src/app/e2e/e2e-walkthrough.ts`. It composes the donor's agent loop
(`composeSubstrateAgent`, `wireMemoryRuntime`, `wireShardAndThinkRuntime`)
in process with the donor's scripted provider and calls `handleMessage`. A
scratch script in the throwaway clone (the appendix below) copies that
composition, wraps the scripted provider in a counter, and supplies the
idle-purity harness's kind of deterministic embedder. It ran over a
throwaway labelled pgvector container and sent three plain participant
messages:

| donor, walkthrough composition | chat-model requests | embedding requests |
|---|---:|---:|
| plain participant turn (each of 3) | 1 | 1 |
| explicit memory extraction over those 3 turns | 0 | 0 |

The comparable figure is the companion request: 1 per plain turn on both.
The donor also makes one embedding request on every plain turn (its memory
retrieval embeds the turn's context text, `faculties/memory/retrieval.ts`).
Lite does not. Not comparable, and stated rather than estimated:

- That composition is not the donor's production turn path. It has no
  Gateway or channel pipeline. It runs with `backgroundWorkDisabled: true`,
  so durable post-turn work does not run, and it has no emotion runtime, so
  no appraisal is made. Lite's estimator request has no donor counterpart
  in this measurement. Wiring the production `core-runtime.ts` composition
  (background work store and emotion runtime) into the scratch script was
  not done.
- The donor's scripted provider never returns tool calls, so the tool-call,
  worker and free-time rows have no donor figure. Matching them needs
  donor-format scripted tool calls in the scratch harness. This is feasible
  but was not built.
- The explicit extraction run made no request. Why was not traced (the
  donor extractor's own gating), so it is not evidence about donor
  maintenance cost.

## Turn latency and memory (Lite)

`scripts/bench/latency.ts`. The scripted model and the counting embedding
port answer at once, so these numbers are Lite's own overhead per turn:
Postgres (pgvector writes and searches over 1,536-dimension vectors
included), the JSONL archive, context assembly, governed dispatch and the
post-turn emotion estimate. They are not a provider's latency, and they
leave out the time a real embedding provider takes. There were 5 warmup
turns, then 100 plain turns, 20 turns with 3 tool calls (memory write and
search, session messages; 40 embedding requests in all) and 50 idle ticks.

| | p50 | p95 | max |
|---|---:|---:|---:|
| participant turn, no tool calls | 5.3 ms | 6.6 ms | 7.3 ms |
| participant turn, 3 tool calls | 9.0 ms | 16.1 ms | 16.1 ms |
| idle scheduler tick | 2.4 ms | 3.8 ms | 8.4 ms |

| Resident set (RSS) | Lite | Donor |
|---|---:|---:|
| runtime process idle, nothing due | 151 MiB after open, 158 MiB max over 30 s | 450 MiB at start, about 897 MiB plateau (899 MiB max) over the idle window |

Lite's figure is the conformance host process: node with tsx's loader, the
standalone runtime, the MCP transport, the lifecycle bridge and the scripted
model, with no embedding provider, sampled from `/proc` once a second. The donor's figure is its
production agent process during the idle-purity run, sampled with `ps` every
2 s (76 samples): node with tsx's loader, the agent, its Gateway and enabled
automata. Both are idle with nothing due. Neither is a production build.

In-process, the benchmark also reports Lite's runtime open at about 1.7 s
(migrations included), a heap of about 73 MiB after 125 turns, and process
RSS rising from 147 MiB at open to 177 MiB after those turns. That RSS
includes the benchmark and the Postgres harness client.

## Limitations

- One machine and one run of each. Latency figures vary by a few
  milliseconds between runs. They show orders of magnitude, not budgets.
- A scripted model makes every call. Real providers add their own latency,
  and their responses change how many tool rounds a turn takes.
- The embedding port is a counting fake that answers at once. Embedding
  request counts are real; provider latency and cost are not included. With
  no provider configured (the conformance setup and standalone's
  `disabled` kind) Lite makes no embedding requests, and writes wait for the
  backfill.
- Lite figures come from the conformance host, which includes the scripted
  model. Donor figures come from its own certification harness. Both run
  under tsx, not from a build.
- Donor per-workload calls are measured only for a plain participant
  turn, in the walkthrough composition, which leaves out the donor's
  post-turn work. The donor tool-call, worker, free-time and maintenance
  rows are feasible with more scratch harness work, and were not built.
- Not measured, as stated above: a donor idle day, donor turn latency, and
  both install times.

## Appendix: donor plain-turn scratch script

Placed at `src/app/e2e/lite-bench-plain-turn.ts` in the throwaway clone only
(never the donor tree), and run against a throwaway labelled pgvector
container. The container's superuser was given the two roles the donor's
fleet manifest names (`single_companion_runtime`,
`shared_schema_migration`), and `POSTGRES_DATABASE_URL`,
`SINGLE_COMPANION_DATABASE_URL` and `SHARED_SCHEMA_MIGRATION_DATABASE_URL`
were set to its URL. The command was
`LOG_LEVEL=error npx tsx src/app/e2e/lite-bench-plain-turn.ts`.

```ts
// Scratch measurement for psfn-lite docs/footprint.md (throwaway clone only).
// Composes the donor's SubstrateAgent the way src/app/e2e/e2e-walkthrough.ts
// does, with its scripted provider wrapped in a counter, and sends plain
// participant turns. Prints provider calls per turn by method and purpose.
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { sanitizeCoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { DEFAULT_REPL_CONFIG } from '../../core/tools/analysis-workbench/types.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { createIsolatedE2ERuntime } from './runtime-harness.js';
import {
  composeIdentity,
  composeMemoryStoreAsync,
  composeSessionRuntimeAsync,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';
import { createScriptedE2ELLMProvider } from './test-llm-provider.js';
import { composeCapabilityRuntime } from '../startup/composition/capability-runtime.js';

const CHANNEL = 'bench:plain-turn';
const calls: string[] = [];
const embeds = { single: 0, batch: 0 };

function counting(inner: LLMProviderPort): LLMProviderPort {
  return {
    ...inner,
    stream: async (...args: Parameters<LLMProviderPort['stream']>) => { calls.push('stream:chat'); return inner.stream(...args); },
    complete: async (...args: Parameters<LLMProviderPort['complete']>) => { calls.push(`complete:${String(args[1])}`); return inner.complete(...args); },
  } as LLMProviderPort;
}

const DIMS = 384;
function vector(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < text.length; i += 1) v[i % DIMS] = (v[i % DIMS] ?? 0) + (text.charCodeAt(i) % 31) / 31;
  return v;
}
const embeddingService = {
  dims: DIMS,
  kind: 'deterministic',
  model: 'deterministic',
  embed: async (t: string) => { embeds.single += 1; return vector(t); },
  embedBatch: async (ts: string[]) => { embeds.batch += 1; return ts.map(vector); },
};

function message(n: number, content: string): SubstrateMessage {
  return { id: `bench-${n}`, channelId: CHANNEL, channelType: 'terminal', authorId: 'primary-user', authorName: 'PrimaryUser', content, timestamp: new Date() };
}

async function main(): Promise<void> {
  const runtime = createIsolatedE2ERuntime({ prefix: 'lite-bench-donor-' });
  const { config } = runtime;
  const eventBus = new EventBus();
  try {
    const { systemPrompt } = composeIdentity(config);
    const llm = counting(createScriptedE2ELLMProvider());
    const { sessionStore, sessionManager } = await composeSessionRuntimeAsync({ config });
    const memoryStore = await composeMemoryStoreAsync(config, DIMS);
    const capabilityRuntime = composeCapabilityRuntime(config, process.env.CONFIG_DIR);
    const agentLoop = composeSubstrateAgent({
      eventBus, llmProvider: llm, sessionManager, systemPrompt,
      config: sanitizeCoreSubstrateConfig(config), backgroundWorkDisabled: true,
    });
    const extractor = wireMemoryRuntime({ agentLoop, llmProvider: llm, sessionManager, sessionStore, memoryStore, embeddingService: embeddingService as never, eventBus, config });
    wireShardAndThinkRuntime({
      agentLoop, eventBus, llmProvider: llm, sessionStore, embeddingService: embeddingService as never, memoryStore, sessionManager, config,
      parentSystemPrompt: systemPrompt, shardParentIcpDelivery: null, replConfig: DEFAULT_REPL_CONFIG,
      snapshotParentCapabilityGrant: () => capabilityRuntime.snapshotOwnerGrant(),
    });
    await eventBus.emit('system.init', {});
    await eventBus.emit('system.ready', {});
    const texts = ['hello there', 'message 2 about the garden', 'message 3 about the garden'];
    const perTurn: Record<string, unknown>[] = [];
    for (const [i, text] of texts.entries()) {
      const before = calls.length;
      const e0 = { ...embeds };
      await agentLoop.handleMessage(message(i, text));
      await new Promise((r) => setTimeout(r, 1500));
      perTurn.push({ text, calls: calls.slice(before), embedSingle: embeds.single - e0.single, embedBatch: embeds.batch - e0.batch });
    }
    const beforeExtract = calls.length;
    await extractor.extract(CHANNEL);
    const extraction = calls.slice(beforeExtract);
    await extractor.stop({ timeoutMs: 10_000 });
    process.stdout.write(`${JSON.stringify({ perTurn, extraction, totals: { calls: calls.length, embeds } }, null, 2)}\n`);
  } finally {
    runtime.cleanup();
  }
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
```
