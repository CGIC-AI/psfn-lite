import {
  ACTIVE_WORKER_STATUSES,
  canViewWorkerRun,
  isTerminalWorker,
  type WorkerEffectPort,
  type WorkerGrant,
  type WorkerRun,
  type WorkerRunPort,
  type WorkerRunStatus,
} from '../automata/index.ts';
import { denied, invalid, ok, type Clock, type Result, type WorkerRunId } from '../shared/index.ts';
import { collectPaged } from './paging.ts';
import { authorOf, isTrustedTurnScope, viewerOf, type TrustedTurnScope } from './trusted-scope.ts';
import type { WorkerRunner } from './worker-runner.ts';

const GUIDANCE_MAX = 2_000;
const GUIDANCE_ENTRIES_MAX = 50;
const QUERY_MAX = 200;

/** The lineage and accounting of a run, without transcripts or reasoning. */
export interface WorkerInspection {
  readonly run: WorkerRun;
  readonly effects: readonly {
    readonly effectKey: string;
    readonly tool: string;
    readonly action: string;
    readonly phase: string;
    readonly attempt: number;
    readonly startedAt: string;
    readonly settledAt: string | null;
  }[];
}

export interface AutomataService {
  spawn(
    scope: TrustedTurnScope,
    input: { readonly spawnId: string; readonly label: string; readonly task: string; readonly grant: WorkerGrant },
  ): Promise<Result<{ readonly run: WorkerRun; readonly created: boolean }>>;
  message(scope: TrustedTurnScope, input: { readonly runId: WorkerRunId; readonly text: string }): Promise<Result<WorkerRun>>;
  /** The run, and whether it has settled. It never blocks: a dispatcher call is request/response. */
  wait(scope: TrustedTurnScope, input: { readonly runId: WorkerRunId }): Promise<Result<{ readonly run: WorkerRun; readonly settled: boolean }>>;
  cancel(scope: TrustedTurnScope, input: { readonly runId: WorkerRunId }): Promise<Result<WorkerRun>>;
  status(
    scope: TrustedTurnScope,
    input: { readonly runId: WorkerRunId | null; readonly limit: number },
  ): Promise<Result<{ readonly active: readonly WorkerRun[]; readonly recent: readonly WorkerRun[] }>>;
  discover(scope: TrustedTurnScope, input: { readonly query: string; readonly limit: number }): Promise<Result<readonly WorkerRun[]>>;
  inspect(scope: TrustedTurnScope, input: { readonly runId: WorkerRunId }): Promise<Result<WorkerInspection>>;
}

/**
 * The model-facing `automata` operations (donor
 * `src/faculties/subagents/tools.ts`). Every run is visible only where its
 * spawning conversation could be read, and an unknown or withheld id reads
 * the same. A request spawn is started at once under the calling turn.
 */
export function createAutomataService(deps: {
  readonly runner: WorkerRunner;
  readonly runs: WorkerRunPort;
  readonly effects: WorkerEffectPort;
  readonly clock: Clock;
}): AutomataService {
  const page = (scope: TrustedTurnScope, statuses: readonly WorkerRunStatus[] | null, limit: number, match?: (r: WorkerRun) => boolean) => {
    const viewer = viewerOf(scope);
    return collectPaged({
      fetch: (after, pageSize) => deps.runs.list({ statuses, limit: pageSize, after }),
      cursorOf: (r: WorkerRun) => ({ createdAt: r.createdAt, id: r.id }),
      keep: (r) => canViewWorkerRun(viewer, r) && (match?.(r) ?? true),
      limit,
    });
  };

  return {
    async spawn(scope, input) {
      const spawned = await deps.runner.spawn(scope, { key: input.spawnId, label: input.label, task: input.task, grant: input.grant, trigger: 'request' });
      if (!spawned.ok) return spawned;
      if (spawned.value.run.status !== 'queued') return spawned;
      const driven = await deps.runner.drive(scope, spawned.value.run.id);
      return driven.ok ? ok({ run: driven.value, created: spawned.value.created }) : driven;
    },

    async message(scope, input) {
      const found = await deps.runner.visible(scope, input.runId);
      if (!found.ok) return found;
      const run = found.value;
      if (isTerminalWorker(run.status)) return invalid(`worker run ${run.id} already settled as ${run.status}`);
      const text = input.text.trim();
      if (text.length === 0 || text.length > GUIDANCE_MAX) return invalid(`guidance must be 1-${GUIDANCE_MAX} characters`);
      if (run.guidance.length >= GUIDANCE_ENTRIES_MAX) return invalid(`a worker holds at most ${GUIDANCE_ENTRIES_MAX} guidance messages`);
      const at = deps.clock.now().toISOString();
      return deps.runs.update(
        { ...run, guidance: [...run.guidance, { at, text, author: authorOf(scope) }], updatedAt: at, revision: run.revision + 1 },
        run.revision,
      );
    },

    async wait(scope, input) {
      const found = await deps.runner.visible(scope, input.runId);
      return found.ok ? ok({ run: found.value, settled: isTerminalWorker(found.value.status) }) : found;
    },

    cancel: (scope, input) => deps.runner.cancel(scope, input.runId),

    async status(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      if (input.runId !== null) {
        const found = await deps.runner.visible(scope, input.runId);
        if (!found.ok) return found;
        return ok(isTerminalWorker(found.value.status) ? { active: [], recent: [found.value] } : { active: [found.value], recent: [] });
      }
      const active = await page(scope, ACTIVE_WORKER_STATUSES, input.limit);
      if (!active.ok) return active;
      const recent = await page(scope, ['completed', 'failed', 'cancelled'], input.limit);
      return recent.ok ? ok({ active: active.value, recent: recent.value }) : recent;
    },

    async discover(scope, input) {
      if (!isTrustedTurnScope(scope)) return denied('unknown_authority', 'scope was not admitted by ingress');
      const query = input.query.trim().toLowerCase();
      if (query.length === 0 || query.length > QUERY_MAX) return invalid(`query must be 1-${QUERY_MAX} characters`);
      return page(scope, null, input.limit, (r) => r.id.toLowerCase().includes(query) || r.label.toLowerCase().includes(query) || r.task.toLowerCase().includes(query));
    },

    async inspect(scope, input) {
      const found = await deps.runner.visible(scope, input.runId);
      if (!found.ok) return found;
      const effects = await deps.effects.list(found.value.id);
      if (!effects.ok) return effects;
      return ok({
        run: found.value,
        effects: effects.value.map((e) => ({
          effectKey: e.effectKey,
          tool: e.tool,
          action: e.action,
          phase: e.phase,
          attempt: e.attempt,
          startedAt: e.startedAt,
          settledAt: e.settledAt,
        })),
      });
    },
  };
}
