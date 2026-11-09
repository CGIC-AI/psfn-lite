// ── Intake sink-gate port ──
//
// Lite extraction (seam 3.4, CogSec cut). The core keeps the optional
// `IntakeSinkGate` port its consumers already accept as `IntakeSinkGate | null`
// (session manager and prompt assembly, memory writer, fact acceptance,
// completion hand-off, egress tool guard, shard fold review). The gate
// implementation (createIntakeSinkGate and its deny and lethal-trifecta policy)
// is cut, so a host has no sink gate to wire and passes null: the donor's own
// firewall-off path (core/session/intake-sink-gating.ts
// INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME).
//
// Declarations copied verbatim from the donor's
// src/core/cogsec/intake/sink-gates.ts at e6a9546 (lines 69-86,103-115,133-151,153-159,166-186,188-190,425-448).
import type {
  IntakeEnvelopeSnapshot,
  IntakeSink,
} from './intake-envelope.js';
import type { IntakeTrifectaEnforcement } from '../../system/config/intake-policy-config.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';

// ── Decision types ──

export interface IntakeSinkGateDecision {
  sink: IntakeSink;
  /**
   * Mode-aware final answer for ordinary sink access. Shadow mode allows (the
   * verdict is still audited); enforce mode allows only on an 'allow' verdict.
   * Lethal-trifecta assessments use the stricter contract below.
   */
  allowed: boolean;
  /** Mode-independent policy evaluation. */
  verdict: 'allow' | 'deny';
  mode: 'shadow' | 'enforce';
  /** Human-auditable reason for the verdict. */
  reason: string;
  /** True when the content reached the sink without any envelope. */
  unscreened: boolean;
  /** Envelope ids that produced a deny verdict (empty for allow/unscreened). */
  deniedEnvelopeIds: readonly string[];
}

/**
 * Content-free routing supplied by a production sink. `correlationRef` is
 * hashed at the gate and never reaches persistence or notification. When it
 * is absent, the denied envelope ids provide the stable replay correlation.
 */
export interface IntakeSinkDenialRouteContext {
  /** Stable identity of this invocation/turn/request. True replays reuse it. */
  attemptRef: string;
  /** Stable identity of one operation within the attempt (for example fact index). */
  correlationRef?: string;
  sourceChannelId?: string;
  logicalSessionId?: string;
}

export interface IntakeEgressTrifectaAssessment {
  /** True when untrusted content + private data + egress all meet in this path. */
  triggered: boolean;
  /** Strongest enforcement across the triggering envelopes' tiers; null when not triggered. */
  enforcement: IntakeTrifectaEnforcement | null;
  verdict: 'allow' | 'deny' | 'review';
  /**
   * Mode-aware, with one fail-closed exception: a hard-enforcement deny
   * blocks in BOTH modes (hrmrq.77) — shadow mode never fails the lethal
   * trifecta open. Soft verdicts allow (with review) in both modes.
   */
  allowed: boolean;
  /** True on a soft verdict: egress proceeds but is flagged for operator review. */
  reviewRequired: boolean;
  mode: 'shadow' | 'enforce';
  reason: string;
  /** Envelope ids whose content participates in the trifecta path. */
  envelopeIds: readonly string[];
}

export interface BlockedEgressTrifectaContext {
  /** Canonical route identity used to place the incident in the operator work surface. */
  sourceChannelId: string;
  logicalSessionId: string;
  /** Structural tool identity only; arguments and content must never cross this seam. */
  toolName: string;
}

/**
 * Capability tokens that constitute EGRESS (data leaving the companion's
 * boundary): outbound notifications, git pushes/PRs, arbitrary shell/code
 * execution, world effectors, and process/agent spawning. Web fetch is
 * ingress and deliberately absent. Kept here (cogsec domain) so the egress
 * leg of the trifecta has one auditable definition.
 */
export const INTAKE_EGRESS_CAPABILITY_TOKENS: readonly CapabilityToken[] = [
  'external.discord',
  'external.email',
  'external.web',
  'external.companion',
  'external.mcp',
  'git.write',
  'repl.execute',
  'world.control',
  'subagent.spawn',
  'shard.spawn',
  'lifecycle.restart',
  'lifecycle.rebuild',
];

export function isEgressCapabilityToken(token: CapabilityToken): boolean {
  return INTAKE_EGRESS_CAPABILITY_TOKENS.includes(token);
}

export interface IntakeSinkGate {
  readonly mode: 'shadow' | 'enforce';
  /**
   * Gate one sink consumption. `envelopes` empty = unscreened content
   * (explicit per-sink policy default). `context` is audit-only.
   */
  evaluate(
    sink: IntakeSink,
    envelopes: readonly IntakeEnvelopeSnapshot[],
    context?: Readonly<Record<string, unknown>>,
    denialRoute?: IntakeSinkDenialRouteContext,
  ): IntakeSinkGateDecision;
  /** Trifecta assessment for the tool-egress sink. */
  assessEgressTrifecta(
    input: {
      envelopes: readonly IntakeEnvelopeSnapshot[];
      privateDataInPath: boolean;
      egressDescription: string;
      /** Required runtime identity when a hard block must become a durable case. */
      blockedIncidentContext?: BlockedEgressTrifectaContext;
    },
    context?: Readonly<Record<string, unknown>>,
  ): IntakeEgressTrifectaAssessment;
}
