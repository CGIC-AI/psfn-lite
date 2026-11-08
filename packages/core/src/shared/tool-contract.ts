import { deepFreeze } from './guards.ts';
import type { Sensitivity } from './privacy.ts';

/** The core domains. Each owns its state and at least one model-facing tool. */
export const DOMAINS = [
  'identity',
  'sessions',
  'contacts',
  'memory',
  'episodes',
  'journals',
  'emotion',
  'intention',
  'activity',
  'automata',
  'scheduler',
] as const;
export type DomainName = (typeof DOMAINS)[number];

export type Access = 'read' | 'write';

/**
 * How an action's results and targets are scoped to an audience.
 *
 * - identity_by_design: the companion's own published identity, shown to any admitted caller.
 * - audience_scoped: each item is filtered by the caller's trust and room ceiling.
 * - conversation_scoped: items are bound to the conversation that created them.
 * - companion_private: only for the companion itself (self audience or a confidential admission).
 * - automata_private: worker-run learned state, never companion memory.
 */
export type PrivacyClass =
  | 'identity_by_design'
  | 'audience_scoped'
  | 'conversation_scoped'
  | 'companion_private'
  | 'automata_private';

/**
 * Declared review/write restrictions. The dispatcher enforces the mechanical
 * ones (foreground_only, self_audience_only, worker access, admission); the
 * owning domain's handler is responsible for the rest.
 */
export type Restriction =
  | 'companion_authored'
  | 'append_only'
  | 'current_scope_only'
  | 'visibility_gated'
  | 'approval_for_protected'
  | 'proposal_only'
  | 'foreground_only'
  | 'self_audience_only'
  | 'idempotent'
  | 'grant_narrowing';

/** What a bounded worker (automaton) may do with this action. */
export type WorkerAccess = 'allowed' | 'review_staged' | 'denied';

/** Whether executing the action may itself make a model call. */
export type Inference = 'none' | 'may_call_model';

/** Traceability to the donor framework at the recorded donor revision. */
export type DonorMapping =
  | { readonly kind: 'donor'; readonly paths: readonly string[] }
  | { readonly kind: 'lite_new'; readonly rationale: string; readonly related: readonly string[] };

export interface ActionDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly access: Access;
  readonly privacy: PrivacyClass;
  /** The scope must admit this sensitivity before the action may run at all. */
  readonly admission: Sensitivity;
  readonly restrictions: readonly Restriction[];
  readonly workers: WorkerAccess;
  readonly inference: Inference;
  readonly donor: DonorMapping;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly domain: DomainName;
  readonly summary: string;
  readonly actions: readonly ActionDescriptor[];
}

/** Declares a domain's model-facing tool as frozen runtime data. */
export function defineTool(tool: ToolDescriptor): ToolDescriptor {
  return deepFreeze(tool);
}
