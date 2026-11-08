import type { WorkerRun, WorkerRunPort } from '../automata/index.ts';
import type { MemoryRecord } from '../memory/index.ts';
import { ok, type Result, type WorkerRunId } from '../shared/index.ts';
import type { MemoryAdministration } from './memory-administration.ts';

const WORKER_PRODUCER = /^worker:(.+)$/;

export interface StagedWorkerWrite {
  readonly memory: MemoryRecord;
  /** The run that staged it, with its source binding; null when the run record is gone. */
  readonly run: WorkerRun | null;
}

/**
 * The operator's review of restricted memory a worker staged (donor
 * `src/faculties/subagents/memory-governance.ts`). Staged writes are never
 * read until approved; each is shown with the run and source that produced
 * it, and the decision goes through memory administration.
 */
export interface WorkerReview {
  pending(limit: number): Promise<Result<readonly StagedWorkerWrite[]>>;
  decide(actor: string, input: { readonly memoryId: string; readonly approve: boolean }): Promise<Result<MemoryRecord>>;
}

export function createWorkerReview(deps: { readonly runs: WorkerRunPort; readonly memory: MemoryAdministration }): WorkerReview {
  return {
    async pending(limit) {
      const staged = await deps.memory.listStaged(limit);
      if (!staged.ok) return staged;
      const out: StagedWorkerWrite[] = [];
      for (const memory of staged.value) {
        const author = memory.provenance.author;
        const match = author.kind === 'machine' ? WORKER_PRODUCER.exec(author.producer) : null;
        if (match?.[1] === undefined) continue;
        const run = await deps.runs.get(match[1] as WorkerRunId);
        if (!run.ok && run.error.kind !== 'not_found') return run;
        out.push({ memory, run: run.ok ? run.value : null });
      }
      return ok(out);
    },
    decide: (actor, input) => deps.memory.reviewStaged(actor, input),
  };
}
