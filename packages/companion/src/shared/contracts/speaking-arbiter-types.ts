// ── Speaking-arbiter shapes the core reads ──
//
// Lite extraction (seam 3.15, with the ICP cut). The speaking arbiter
// (src/core/agent/arbiter: reservation, egress lease and Law-36 breaker for
// multi-party rooms) is gateway-owned scaffolding and is not core. Two core
// modules refer to its shapes by type only: core/icp/speaking-precedence-resolver.ts
// implements the arbiter's IcpSocialPrecedenceResolver port, and
// shared/event-bus.ts types the arbiter's telemetry events. Without an arbiter
// neither is called or emitted; the event contract stays unchanged.
//
// Declarations copied verbatim from the donor at e6a9546:
// src/core/agent/arbiter/reservation-phase.ts (lines 67-85, 96-116),
// src/core/agent/arbiter/egress-lease-phase.ts (lines 169-203),
// src/core/agent/arbiter/speaking-arbiter-store-port.ts (lines 89-98, 318-325).
import type { IcpSocialPrecedenceInput } from '../../core/icp/social-precedence.js';

/** The deterministic context a reservation gate resolves its signals from. */
export interface ReservationSignalContext {
  channelId: string;
  /** The room event that made this companion a candidate (candidate.sourceMessageId). */
  triggerEventId: string;
  companionId: string;
  nowMs: number;
}

/**
 * Resolves the ICP-over-social precedence inputs for a candidate. ICP is a
 * separate, dominant autonomy authority; where it contends, social yields
 * (§8.5). The live signals (current availability lease, in-flight ICP turn
 * fence, ICP continuation exhaustion) are wired by the ICP transport seam
 * (jp36.5.2); this phase only consumes the resolved inputs.
 */
export interface IcpSocialPrecedenceResolver {
  resolve(ctx: ReservationSignalContext): IcpSocialPrecedenceInput | Promise<IcpSocialPrecedenceInput>;
}

/** Why a candidate was gated out before appraisal. */
export type ReservationGateBlockReason =
  /** An in-flight ICP turn fence is live for this scope; social must not race it. */
  | 'icp_turn_fenced'
  /** The ICP continuation fatigue lane is at its hard stop. */
  | 'icp_fatigue_exhausted'
  /** The companion's own ICP availability lease is a non-open state (DND/busy/resting). */
  | 'icp_availability'
  /** Decayed room-episode pressure is at/above the Law-36 breaker trip threshold. */
  | 'room_flooded'
  /** The social pot cannot fund even a minimal social turn. */
  | 'fatigue_pot_insufficient'
  /** Fail-closed: a gate signal, gate input, or the store errored. */
  | 'gate_error';

/** The stage at which a `gate_error` occurred (content-free, for telemetry). */
export type ReservationGateErrorStage =
  | 'icp_precedence'
  | 'room_pressure'
  | 'social_pot'
  | 'reserve';

/** The lifecycle stage a fail-closed `gate_error` occurred at (content-free). */
export type EgressLeaseErrorStage =
  | 'trigger'
  | 'room_pressure'
  | 'breaker'
  | 'fairness'
  | 'social_pot'
  | 'acquire'
  | 'deliver'
  | 'complete';

/** The terminal outcome of an egress evaluation. */
export type EgressLeaseOutcome =
  /** The reply was delivered and its lease completed `delivered`. */
  | 'delivered'
  /** The lease was acquired but the send failed; lease completed `failed`. */
  | 'delivery_failed'
  /** Shadow posture admitted the reply but deliberately performed no draw or send. */
  | 'shadowed'
  /** The reservation was no longer `reserved` (redelivery/settled); no bind. */
  | 'reservation_not_reservable'
  /** The Law-36 breaker suppressed the autonomous lease (open / spent probe). */
  | 'breaker_suppressed'
  /** Pressure raised the confidence bar above the appraisal (soft wrap-up). */
  | 'below_confidence_bar'
  /** A less-recent contender should speak; this companion yielded (speak-least). */
  | 'yielded_speak_least'
  /** The social pot refused to fund the turn (capped/insufficient/uncharged). */
  | 'draw_refused'
  /** Acquire declined: a live holder, or the event was already spoken. No retry. */
  | 'lease_declined'
  /** Fail-closed: a gate signal, resolver, or store errored. No send. */
  | 'gate_error'
  /** A retained `react` reservation was released (no speaking lease). */
  | 'react_released';


/**
 * Durable Law-36 circuit-breaker position for a channel's room episode (charter
 * §8.11, bible §12.2/§20.2). Persisted in the arbiter store — the gateway-owned
 * home the design mandates — so the single-probe half-open discipline survives a
 * gateway reboot. Mirrors the pure breaker state machine's positions
 * (`../fatigue/room-episode-circuit-breaker`); kept as a local string union so
 * this low-level store contract does not depend on the fatigue module.
 */
export type RoomEpisodeBreakerState = 'closed' | 'open' | 'half_open';

/**
 * Why an acquisition was declined:
 *   - `held`: a live held lease currently owns the triggering event;
 *   - `already_delivered`: the event was already spoken (a prior lease reached a
 *     `delivered`/`overridden` completion), so it is spent — send-once fencing.
 * In both cases the caller does NOT retry (silence is never retried into speech).
 */
export type AcquireEgressLeaseDeclineReason = 'held' | 'already_delivered';
