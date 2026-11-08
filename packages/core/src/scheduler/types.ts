import type { ActivityId, Author, Result } from '../shared/index.ts';

export const FREE_TIME_LANES = ['quiet_hours', 'idle'] as const;
export type FreeTimeLane = (typeof FREE_TIME_LANES)[number];

/**
 * Why a lane is quiet. A failure that ends a block is recorded as a system
 * failure, never as the companion's own decision to rest.
 */
export type RestDecision =
  | { readonly kind: 'companion_rested'; readonly until: string; readonly decidedAt: string }
  | { readonly kind: 'companion_deferred'; readonly until: string; readonly decidedAt: string }
  | { readonly kind: 'system_failure'; readonly until: string; readonly decidedAt: string; readonly reason: string };

export const FREE_TIME_OPTION_KINDS = ['rest', 'reflect', 'wander', 'resume_project', 'begin_new'] as const;
export type FreeTimeOptionKind = (typeof FREE_TIME_OPTION_KINDS)[number];

/** A pre-built option; the companion can only select one, never mint a destination. */
export interface FreeTimeOption {
  readonly optionId: string;
  readonly kind: FreeTimeOptionKind;
  readonly label: string;
  /** For `resume_project`: the interrupted activity it resumes. */
  readonly activityId: ActivityId | null;
}

export type FreeTimeGate =
  | { readonly kind: 'eligible'; readonly options: readonly FreeTimeOption[] }
  | {
      readonly kind: 'ineligible';
      readonly reason:
        | 'silenced'
        | 'outside_quiet_hours'
        | 'invitation_open'
        | 'recent_partner_activity'
        | 'min_interval'
        | 'daily_cap'
        | 'rest_state_unavailable';
    };

/** Durable, extend-only rest state that survives restart. */
export interface RestStatePort {
  read(lane: FreeTimeLane): Promise<Result<RestDecision | null>>;
  /** Keeps whichever decision ends later; a later rest never shortens a quiet period. Returns the decision in force. */
  extend(lane: FreeTimeLane, decision: RestDecision): Promise<Result<RestDecision>>;
}

/**
 * One free-time opportunity. It is recorded before the companion is asked,
 * and the store holds at most one open block (invited, chosen or executing)
 * across every lane, so a crash or a concurrent scheduler pass cannot invite
 * twice.
 */
export const OPEN_FREE_TIME_BLOCK_STATES = ['invited', 'chosen', 'executing'] as const;

export const FREE_TIME_BLOCK_STATES = ['invited', 'chosen', 'executing', 'completed', 'rested', 'deferred', 'lapsed', 'failed', 'interrupted'] as const;
export type FreeTimeBlockState = (typeof FREE_TIME_BLOCK_STATES)[number];

export interface FreeTimeBlock {
  readonly id: string;
  readonly lane: FreeTimeLane;
  readonly state: FreeTimeBlockState;
  readonly options: readonly FreeTimeOption[];
  readonly invitedAt: string;
  /** Local calendar day of the invitation in the policy's time zone, for the daily cap. */
  readonly localDay: string;
  readonly decidedAt: string | null;
  readonly choice: FreeTimeOption | null;
  readonly activityId: ActivityId | null;
  /** What happened, in the words of whoever produced it. */
  readonly outcome: string | null;
  /** A system failure, labelled as one; never presented as the companion's choice. */
  readonly failure: string | null;
  readonly revision: number;
}

export interface FreeTimeBlockPort {
  /**
   * An existing id is an `already_exists` conflict. A block created while
   * another one is open (any lane) is a `turn_already_open` conflict.
   */
  create(block: FreeTimeBlock): Promise<Result<FreeTimeBlock>>;
  get(id: string): Promise<Result<FreeTimeBlock>>;
  /** The lane's most recent blocks, newest invitation first. */
  recent(lane: FreeTimeLane, limit: number): Promise<Result<readonly FreeTimeBlock[]>>;
  update(next: FreeTimeBlock, expectedRevision: number): Promise<Result<FreeTimeBlock>>;
}

export const SCHEDULED_PROMPT_STATES = ['pending', 'running', 'completed', 'failed', 'interrupted'] as const;
export type ScheduledPromptState = (typeof SCHEDULED_PROMPT_STATES)[number];

/** A one-shot self-prompt the companion scheduled for a later self turn. */
export interface ScheduledPrompt {
  /** Derived from the companion's key, so a retried schedule is the same prompt. */
  readonly id: string;
  readonly requestDigest: string;
  readonly name: string;
  readonly prompt: string;
  readonly runAt: string;
  readonly timeZone: string;
  /** The local wall time as the companion gave it. */
  readonly localTime: string;
  readonly state: ScheduledPromptState;
  readonly author: Author;
  readonly createdAt: string;
  readonly firedAt: string | null;
  readonly outcome: string | null;
  readonly revision: number;
}

export interface ScheduledPromptCursor {
  readonly runAt: string;
  readonly id: string;
}

export interface ScheduledPromptPort {
  /** Idempotent by id: an existing id returns the stored prompt with `created: false`. */
  create(prompt: ScheduledPrompt): Promise<Result<{ readonly prompt: ScheduledPrompt; readonly created: boolean }>>;
  get(id: string): Promise<Result<ScheduledPrompt>>;
  /** One page, earliest run first. A page shorter than `limit` means the store is exhausted. */
  list(query: {
    readonly states: readonly ScheduledPromptState[] | null;
    readonly dueAtOrBefore: string | null;
    readonly limit: number;
    readonly after: ScheduledPromptCursor | null;
  }): Promise<Result<readonly ScheduledPrompt[]>>;
  update(next: ScheduledPrompt, expectedRevision: number): Promise<Result<ScheduledPrompt>>;
}

export type TemplateSchedule =
  | { readonly kind: 'manual' }
  | { readonly kind: 'daily'; readonly localTime: string; readonly timeZone: string };

/** The fenced record of one template run: a crash mid-run leaves it `running`, read later as interrupted. */
export interface TemplateRun {
  readonly key: string;
  readonly state: 'running' | 'completed' | 'failed' | 'interrupted';
  readonly reflectionId: string | null;
  readonly at: string;
  readonly detail: string | null;
}

/** A companion-owned reflection template. */
export interface ReflectionTemplate {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: TemplateSchedule;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastRun: TemplateRun | null;
  /** A run requested while the companion was busy or outside a self turn, taken by the next scheduler tick. */
  readonly pendingRun: { readonly key: string; readonly requestedAt: string } | null;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface ReflectionTemplatePort {
  get(id: string): Promise<Result<ReflectionTemplate>>;
  list(limit: number): Promise<Result<readonly ReflectionTemplate[]>>;
  /** `expectedRevision` 0 creates; otherwise compare-and-set. */
  put(next: ReflectionTemplate, expectedRevision: number): Promise<Result<ReflectionTemplate>>;
}
