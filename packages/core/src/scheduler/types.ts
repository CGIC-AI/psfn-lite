import type { Result } from '../shared/index.ts';

export type FreeTimeLane = 'quiet_hours' | 'idle';

/**
 * Why a lane is quiet. A failure that ends a block is recorded as a system
 * failure, never as the companion's own decision to rest.
 */
export type RestDecision =
  | { readonly kind: 'companion_rested'; readonly until: string }
  | { readonly kind: 'companion_deferred'; readonly until: string }
  | { readonly kind: 'system_failure'; readonly until: string; readonly reason: string };

/** A pre-built option; the companion can only select one, never mint a destination. */
export interface FreeTimeOption {
  readonly optionId: string;
  readonly kind: 'rest' | 'wander' | 'resume_project' | 'begin_new';
  readonly label: string;
}

export type FreeTimeGate =
  | { readonly kind: 'eligible'; readonly options: readonly FreeTimeOption[] }
  | {
      readonly kind: 'ineligible';
      readonly reason: 'silenced' | 'recent_partner_activity' | 'min_interval' | 'daily_cap' | 'rest_state_unavailable';
    };

/** Durable, extend-only rest state that survives restart. */
export interface RestStatePort {
  read(lane: FreeTimeLane): Promise<Result<RestDecision | null>>;
  extend(lane: FreeTimeLane, decision: RestDecision): Promise<Result<RestDecision>>;
}
