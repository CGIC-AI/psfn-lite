/**
 * Model calls Lite makes, counted by the scripted model (each call is one
 * provider request): over a simulated idle day of scheduler ticks under the
 * baseline policies, and per workload (a participant turn, a turn with tool
 * calls, maintenance after a conversation ends, a worker, a free-time block).
 *
 * Run: tsx scripts/bench/inference.ts [--json]
 * Needs Docker (a throwaway labelled pgvector container per measurement).
 * The clock is simulated, so a day of ticks takes seconds; nothing here
 * calls a real provider.
 */
import type { PlannedCall } from '../../tests/conformance/scenario.ts';
import { callsDuring, environment, withLiteHost } from './lite-host.ts';

const TICK_MINUTES = 1;
const DAY_TICKS = (24 * 60) / TICK_MINUTES;

export interface IdleDay {
  readonly choice: string;
  readonly ticks: number;
  readonly ticksWithCalls: number;
  readonly calls: Record<string, number>;
  readonly blocks: Record<string, number>;
  readonly skipped: Record<string, number>;
}

/** A day of one-minute ticks with nobody talking; every free-time invitation is answered with `choice`. */
async function idleDay(choice: string): Promise<IdleDay> {
  return withLiteHost(async (host) => {
    let ticksWithCalls = 0;
    const blocks: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    const calls = await callsDuring(host, async () => {
      for (let i = 0; i < DAY_TICKS; i += 1) {
        host.advance(TICK_MINUTES);
        const report = await host.tick({ choice, reflection: 'A quiet thought about the garden.' });
        if (Number(report['modelCalls']) > 0) ticksWithCalls += 1;
        for (const lane of (report['freeTime'] as string[] | undefined) ?? []) {
          const [kind, detail] = lane.split(':') as [string, string];
          const into = kind === 'ran' ? blocks : skipped;
          into[detail] = (into[detail] ?? 0) + 1;
        }
      }
    });
    return { choice, ticks: DAY_TICKS, ticksWithCalls, calls, blocks, skipped };
  });
}

const TOOL_TURN: readonly PlannedCall[] = [
  { tool: 'memory', action: 'write', args: { writeId: 'bench-1', kind: 'fact', content: 'Robin grows tomatoes', sensitivity: 'personal' } },
  { tool: 'concern', action: 'create', args: { text: 'The tomatoes need staking' } },
  { tool: 'activity', action: 'start', args: { purpose: 'Planning the tomato beds' } },
];

async function workloads(): Promise<Record<string, Record<string, number>>> {
  return withLiteHost(async (host) => {
    const out: Record<string, Record<string, number>> = {};
    let n = 0;
    const turn = (calls: readonly PlannedCall[]) => host.piTurn({ say: `message ${String((n += 1))}`, calls, reply: 'Noted.', hang: false, vars: {}, key: `bench-${String(n)}` });
    out['participant turn, no tool calls'] = await callsDuring(host, () => turn([]));
    out['participant turn, 3 tool calls'] = await callsDuring(host, () => turn(TOOL_TURN));
    host.workerPlan({ calls: [{ tool: 'memory', action: 'search', args: { query: 'tomatoes' } }, { tool: 'memory', action: 'search', args: { query: 'beds' } }], reply: 'Looked.' });
    out['participant turn spawning a worker (2 worker tool calls)'] = await callsDuring(host, () =>
      turn([{ tool: 'automata', action: 'spawn', args: { spawnId: 'bench-w', label: 'helper', task: 'Look up the tomato notes', actions: ['memory.search'], maxTurns: 4, maxSensitivity: 'public' } }]),
    );
    host.advance(31);
    out['maintenance after the conversation ended (3 turns, nothing extracted)'] = await callsDuring(host, () => host.maintain([]));
    out['maintenance with nothing new'] = await callsDuring(host, () => host.maintain([]));
    host.advance(181);
    out['one free-time block, reflection chosen'] = await callsDuring(host, () => host.tick({ choice: 'reflect', reflection: 'Tomatoes and sun.' }));
    host.advance(181);
    out['one free-time block, rest chosen'] = await callsDuring(host, () => host.tick({ choice: 'rest' }));
    out['tick while resting (nothing due)'] = await callsDuring(host, () => host.tick({ choice: 'rest' }));
    return out;
  });
}

async function main(json: boolean): Promise<void> {
  const days = [await idleDay('rest'), await idleDay('reflect'), await idleDay('ignore')];
  const per = await workloads();
  const result = { environment: environment(), tickMinutes: TICK_MINUTES, idleDays: days, workloads: per };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const kinds = ['companion', 'estimator', 'inference', 'worker'];
  const row = (label: string, calls: Record<string, number>) => `| ${label} | ${kinds.map((k) => String(calls[k] ?? 0)).join(' | ')} | ${String(kinds.reduce((s, k) => s + (calls[k] ?? 0), 0))} |`;
  const lines = [`| workload | ${kinds.join(' | ')} | total |`, `|---|${kinds.map(() => '---:').join('|')}|---:|`];
  for (const day of days) lines.push(row(`idle day, ${String(day.ticks)} ticks, invitations answered "${day.choice}" (${String(day.ticksWithCalls)} ticks made calls; blocks ${JSON.stringify(day.blocks)})`, day.calls));
  for (const [label, calls] of Object.entries(per)) lines.push(row(label, calls));
  process.stdout.write(`${lines.join('\n')}\n\nskip reasons per idle day: ${JSON.stringify(days.map((d) => ({ choice: d.choice, skipped: d.skipped })))}\n`);
}

main(process.argv.includes('--json')).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
