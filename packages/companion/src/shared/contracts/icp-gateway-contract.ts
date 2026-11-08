// ── ICP broker contract shapes ──
//
// Lite extraction (seam 3.15, gateway cut). The inter-companion protocol (ICP)
// broker that issues permits, tracks dyads and reports availability lives in
// the donor gateway, which is not core. The kept core/icp adapters reach it
// only through ports a host wires (IcpAgentGatewayPort in
// core/icp/agent-facing-autonomy.ts, the source runtime's gateway port, and
// IcpRuntimeAvailabilityGatewayPort). These are the result shapes those ports
// return.
//
// With no broker (the Lite default) no ICP runtime is composed, which is the
// donor's own mode for a companion that is not in a multi-companion fleet
// (app/agent/core-runtime.ts:426-432 composes the agent-facing runtime only
// when `config.multiCompanion === true`; app/agent/icp-initiation-source-wiring.ts
// composes the source runtime and its adapters only when ICP autonomy is
// enabled). Each consumer then takes its donor no-ICP path: self_status's
// availability actions answer that the ICP availability runtime is not wired
// (core/tools/self-status.ts:636-638), the companion handoff is reachable only
// from the notify tool (core/tools/ntfy.ts), which is outside the core, the
// contact tools' peer availability is optional and absent, social desire's
// human policy refuses a companion target
// (core/intention/social-desire-human-policy.ts, social_desire_human_target_is_companion),
// and weighted thoughts skip the ICP branch and take the human lane
// (core/intention/weighted-thought-outreach.ts). Human-target outreach is
// unchanged.
//
// Declarations copied verbatim from the donor's
// src/boundary/gateway/icp-autonomy-contract.ts at e6a9546 (lines 29-88,
// 113-138, 154-163).
import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpDyadDeliveryOutcome,
  IcpDyadParticipantState,
  IcpDyadStatus,
  IcpConversationEpisode,
  IcpInitiationPermit,
} from './icp-autonomy.js';

export type IcpGateReasonClass = 'deferrable' | 'terminal';

export interface IcpOpenDyadProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: 'open';
  lifecycleRevision: number;
  availability: IcpPeerAvailabilityResult;
  lastDeliveryOutcome?: IcpDyadDeliveryOutcome;
  lastDeliveryAtMs?: number;
}

export interface IcpDyadLifecycleProjection {
  dyadId: string;
  peerCompanionId: string;
  channelId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
}

export interface IcpDyadContinuationAuthorization {
  dyadId: string;
  deliveryId: string;
  peerCompanionId: string;
  channelId: string;
  dyadLifecycleRevision: number;
  episode: IcpConversationEpisode;
}

export type IcpDyadContinuationPrepareResult =
  | { status: 'authorized'; authorization: IcpDyadContinuationAuthorization }
  | {
      status: 'need_initiation';
      reasonCode: Extract<IcpAutonomyReasonCode,
        'dyad_not_found' | 'dyad_closed' | 'stale_provenance'>;
    }
  | {
      status: 'unavailable';
      reasonCode: IcpAutonomyReasonCode;
    };

interface IcpDyadLifecycleUpdatedResult {
  outcome: 'updated';
  dyadId: string;
  status: IcpDyadStatus;
  ownState: IcpDyadParticipantState;
  peerState: IcpDyadParticipantState;
  lifecycleRevision: number;
  revokedPermitCount: number;
  fencedDeliveryCount: number;
}

export type IcpDyadLifecycleResult = IcpDyadLifecycleUpdatedResult | {
  outcome: 'unavailable';
  reasonCode: Extract<IcpAutonomyReasonCode,
    'dyad_not_found' | 'dyad_paused' | 'dyad_closed' | 'dyad_blocked' | 'dyad_stale_revision'>;
};

export interface IcpInitiationGateDecision {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  reasonClass?: IcpGateReasonClass;
}

export interface IcpInitiationPermitIssueResult {
  decision: IcpInitiationGateDecision;
  permit?: IcpInitiationPermit;
}

export interface IcpPeerAvailabilityResult {
  peerCompanionId: string;
  connectionState: 'online' | 'offline';
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
}

export interface IcpOwnAvailabilityResult {
  eligible: boolean;
  reasonCode?: IcpAutonomyReasonCode;
  lease?: IcpAvailabilityLease;
  control: 'missing' | 'expired' | 'companion' | 'runtime' | 'operator_override';
  mutableByCompanion: boolean;
}

export type IcpInitiationHandoffPrepareResult =
  | {
      authorized: true;
      permit: IcpInitiationPermit;
      rootInitiationId: string;
    }
  | {
      authorized: false;
      reasonCode: IcpAutonomyReasonCode;
    };
