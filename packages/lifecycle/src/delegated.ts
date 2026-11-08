/**
 * Internal turns (free time, scheduled prompts) delegated to an external
 * host. Core asks its `InternalTurnPort` to run a turn; the MCP internal-turn
 * credentials mint one credential for it; this queue holds the request until
 * the one configured internal-turn host claims it over the bridge, then waits
 * for that host to settle the turn it prepares with the minted credential.
 * The trigger, purpose and idempotency key come from core's request, never
 * from the host. A request nobody claims, or a claimed turn that never
 * settles, resolves as unavailable after its timeout and its open turn (if
 * any) is settled as failed, so a missing host is visible rather than silent.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  invalid,
  ok,
  unavailable,
  type IdempotencyKey,
  type InternalTurnPort,
  type InternalTurnRequest,
  type InternalTurnResult,
  type Result,
  type TrustedTurnScope,
  type TurnId,
} from './core.ts';
import type { McpInternalTurns } from './mcp.ts';

export interface DelegatedJob {
  readonly jobId: string;
  readonly request: InternalTurnRequest;
  readonly idempotencyKey: IdempotencyKey;
  /** The minted credential; handed to the host once, at claim, for its MCP and bridge calls in this turn. */
  readonly credential: string;
}

/** What the bridge does with a job's open turn when the job ends without a settlement. */
export type AbandonTurn = (scope: TrustedTurnScope, turnId: TurnId, jobId: string, error: { readonly code: string; readonly message: string }) => Promise<void>;

export interface DelegatedInternalTurns {
  readonly port: InternalTurnPort;
  /** The next queued job, waiting up to `waitMs` for one; null when none arrived. */
  claim(waitMs: number): Promise<DelegatedJob | null>;
  /** The claimed job a minted credential belongs to, or null. */
  jobFor(credential: string): DelegatedJob | null;
  /** Records the turn a job's host prepared, so an abandoned job can settle it. */
  bindTurn(jobId: string, scope: TrustedTurnScope, turnId: TurnId): void;
  /** The job's turn settled; core's request completes with this result. */
  complete(jobId: string, result: InternalTurnResult): void;
  /** The host could not run a claimed job. */
  release(jobId: string, error: { readonly code: string; readonly message: string }): Promise<Result<void>>;
  /** Fails every pending job; later requests are refused. */
  close(): Promise<void>;
}

export interface DelegatedOptions {
  readonly credentials: Pick<McpInternalTurns, 'createTurnPort'>;
  /** Longest a request waits for the host to claim it. */
  readonly claimTimeoutMs: number;
  /** Longest a claimed turn may take to settle; at most the minted credential's lifetime. */
  readonly runTimeoutMs: number;
  readonly abandon: AbandonTurn;
}

interface Job extends DelegatedJob {
  readonly digest: Buffer;
  state: 'queued' | 'claimed';
  turn: { readonly scope: TrustedTurnScope; readonly turnId: TurnId } | null;
  timer: NodeJS.Timeout | null;
  readonly finish: (result: Result<InternalTurnResult>) => void;
}

export function createDelegatedInternalTurns(options: DelegatedOptions): Result<DelegatedInternalTurns> {
  const issues: string[] = [];
  if (!Number.isSafeInteger(options.claimTimeoutMs) || options.claimTimeoutMs < 1) issues.push('claimTimeoutMs must be a positive integer');
  if (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1) issues.push('runTimeoutMs must be a positive integer');
  if (issues.length > 0) return invalid(...issues);
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const claimers: ((job: Job | null) => void)[] = [];
  let closed = false;

  const end = async (job: Job, result: Result<InternalTurnResult>, error: { readonly code: string; readonly message: string } | null) => {
    if (!jobs.delete(job.jobId)) return;
    if (job.timer !== null) clearTimeout(job.timer);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    if (error !== null && job.turn !== null) await options.abandon(job.turn.scope, job.turn.turnId, job.jobId, error);
    job.finish(result);
  };

  const launch = (request: InternalTurnRequest, credential: string): Promise<Result<InternalTurnResult>> => {
    if (closed) return Promise.resolve(unavailable('internal_turn_host', 'the lifecycle bridge is closing'));
    return new Promise((resolve) => {
      const job: Job = {
        jobId: randomBytes(18).toString('base64url'),
        request,
        idempotencyKey: internalKey(request),
        credential,
        digest: digestOf(credential),
        state: 'queued',
        turn: null,
        timer: null,
        finish: resolve,
      };
      jobs.set(job.jobId, job);
      job.timer = setTimeout(() => {
        void end(job, unavailable('internal_turn_host', 'no internal-turn host claimed the turn in time'), null);
      }, options.claimTimeoutMs);
      const waiting = claimers.shift();
      if (waiting === undefined) queue.push(job);
      else waiting(job);
    });
  };

  const take = (job: Job): Job => {
    job.state = 'claimed';
    if (job.timer !== null) clearTimeout(job.timer);
    const failure = { code: 'internal_turn_timeout', message: 'the internal-turn host did not settle the turn in time' };
    job.timer = setTimeout(() => void end(job, unavailable('internal_turn_host', failure.message), failure), options.runTimeoutMs);
    return job;
  };

  return ok({
    port: options.credentials.createTurnPort(launch),
    claim(waitMs) {
      if (closed) return Promise.resolve(null);
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(take(next));
      if (waitMs === 0) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = (job: Job | null) => {
          clearTimeout(timer);
          resolve(job === null ? null : take(job));
        };
        const timer = setTimeout(() => {
          const index = claimers.indexOf(waiter);
          if (index >= 0) claimers.splice(index, 1);
          resolve(null);
        }, waitMs);
        claimers.push(waiter);
      });
    },
    jobFor(credential) {
      const probe = digestOf(credential);
      let found: Job | null = null;
      for (const job of jobs.values()) if (timingSafeEqual(probe, job.digest) && job.state === 'claimed') found = job;
      return found;
    },
    bindTurn(jobId, scope, turnId) {
      const job = jobs.get(jobId);
      if (job !== undefined) job.turn = { scope, turnId };
    },
    complete(jobId, result) {
      const job = jobs.get(jobId);
      if (job !== undefined) void end(job, ok(result), null);
    },
    async release(jobId, error) {
      const job = jobs.get(jobId);
      if (job === undefined || job.state !== 'claimed') return invalid(`job ${jobId} is not a claimed internal turn`);
      await end(job, unavailable('internal_turn_host', `the internal-turn host could not run the turn: ${error.code}`), error);
      return ok(undefined);
    },
    async close() {
      closed = true;
      for (const waiter of claimers.splice(0)) waiter(null);
      const failure = { code: 'bridge_shutdown', message: 'the lifecycle bridge closed before the turn settled' };
      await Promise.all([...jobs.values()].map((job) => end(job, unavailable('internal_turn_host', failure.message), failure)));
    },
  });
}

/** The same key the native harness derives, so a retried request is the same turn. */
function internalKey(request: InternalTurnRequest): IdempotencyKey {
  const hash = createHash('sha256').update(`${request.reference.id}\n${request.prompt}`).digest('hex').slice(0, 40);
  return `internal:${request.reference.kind}:${hash}` as IdempotencyKey;
}

function digestOf(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}
