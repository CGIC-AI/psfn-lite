// ── Fatigue event types (type contract) ──
//
// Lite extraction (operator ruling: fatigue is scaffolding; copy only the
// type-only declarations shared/event-bus.ts needs). The fatigue budget,
// enforcement, social pot, room-episode pressure and circuit breaker are cut.
// The event bus keeps the payload types of the events those components emit
// ('agent.human_attention_pressure' and the speaking-arbiter decision fields),
// so the event contract is unchanged; nothing in the core emits them. The three
// ROOM_EPISODE_CIRCUIT_BREAKER_* constants are copied because the firing record
// types its fields with `typeof` them.
//
// Copied verbatim from the donor at e6a9546:
// - src/core/agent/fatigue/human-attention-pressure.ts:7-41;
// - src/core/agent/fatigue/room-episode-circuit-breaker.ts:50-64, :77-78, :80-102;
// - src/core/agent/fatigue/social-pot-enforcement.ts:54-62.

import type { TrustLevel } from '../../system/trust/types.js';
import type { RelationshipType } from '../../core/contacts/types.js';

export type HumanAttentionChannelContext =
  | 'direct_message'
  | 'direct_mention'
  | 'ambient_group_message';

export type HumanAttentionPressureDecision =
  | 'clear'
  | 'boundary_alert'
  | 'cooldown';

export type HumanAttentionPressureReason =
  | 'below_threshold'
  | 'threshold_reached'
  | 'boundary_cooldown_active'
  | 'policy_disabled';

export interface HumanAttentionPressureEvent {
  schemaVersion: 1;
  timestampMs: number;
  localCompanionId: string;
  contactId: string;
  channelId: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  channelContext: HumanAttentionChannelContext;
  weight: number;
  pressureInWindow: number;
  threshold: number;
  decision: HumanAttentionPressureDecision;
  reason: HumanAttentionPressureReason;
  suppressTurn: false;
  sourceMessageId: string;
  turnId: string;
  cooldownUntilMs?: number;
}

/**
 * Named protected condition (charter §8.11 rule 1): the room's aggregate machine
 * pressure has run away past the wrap-up band, drowning out human participation.
 */
export const ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION = 'room_episode_machine_flood' as const;

/**
 * The single action the breaker may interrupt (charter §8.11 rule 2: narrowest
 * practical interruption). It denies the next autonomous speaking lease only —
 * never a human-triggered turn, never room history.
 */
export const ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION = 'autonomous_speaking_lease' as const;

/** System attribution marker: this is a circuit-breaker signal, never companion voice. */
export const ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION = 'system_circuit_breaker' as const;

/** The transition that produced a firing record (a fresh trip into `open`). */
export type RoomEpisodeCircuitBreakerTransition = 'closed_to_open' | 'half_open_to_open';

/**
 * Auditable firing record (charter §8.11 rule 3). Emitted only on a transition
 * INTO `open`. Every field is structural — an enum, a number, or the channel id
 * — so the record can never masquerade as companion mood or prose.
 */
export interface RoomEpisodeCircuitBreakerFiring {
  protectedCondition: typeof ROOM_EPISODE_CIRCUIT_BREAKER_PROTECTED_CONDITION;
  attribution: typeof ROOM_EPISODE_CIRCUIT_BREAKER_ATTRIBUTION;
  channelId: string;
  transition: RoomEpisodeCircuitBreakerTransition;
  /** The action this firing suppressed. */
  actionSuppressed: typeof ROOM_EPISODE_CIRCUIT_BREAKER_SUPPRESSED_ACTION;
  /** The signals that contributed to the trip (§8.11: "which signals contributed"). */
  signals: {
    pressure: number;
    tripThreshold: number;
    resetThreshold: number;
    /** Wrap-up band the breaker sits above; proves soft wrap-up preceded suppression. */
    wrapUpThreshold: number;
    contributingEventCount: number;
  };
  firedAtMs: number;
}

export type SocialPotEnforcementOutcome =
  /** The full amount was drawn from the pot. */
  | 'drawn'
  /** Refused: the amount exceeds the per-channel share of the remaining pot. */
  | 'capped'
  /** Refused: the pot balance is below the requested amount. */
  | 'insufficient'
  /** Not charged: a human/non-autonomous trigger never draws from the pot. */
  | 'uncharged';
