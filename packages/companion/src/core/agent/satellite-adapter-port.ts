import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  CompanionPresenceMetadata,
  EmbodimentPresenceMetadata,
  SatellitePresenceMetadata,
} from './presence-metadata.js';
import {
  resolveCanonicalEmbodimentContext,
  resolveCanonicalSatelliteContext,
} from './active-emanation-state.js';

export interface SatelliteShardDelegationHint {
  eligible: boolean;
  reason?: string;
}

export interface SatelliteDelegationRoutingHint {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  presence?: CompanionPresenceMetadata;
  shardDelegation?: SatelliteShardDelegationHint;
}

export interface SatelliteDelegationDecision {
  adapterId: string;
  isSatellite: boolean;
  delegate: boolean;
  reason: string;
  routing?: SatelliteDelegationRoutingHint;
}

export interface SatelliteRoutingPort {
  evaluateDelegation(
    message: SubstrateMessage,
    config: SubstrateConfig,
    companionId: string,
  ): SatelliteDelegationDecision | undefined;
}

export interface SatellitePresencePort {
  resolveCanonicalEmbodiment(value: unknown): EmbodimentPresenceMetadata | undefined;
  resolveCanonicalSatellite(value: unknown): SatellitePresenceMetadata | undefined;
}

// Lite extraction (seam 3.12, channels cut): the donor's
// SatelliteChannelAdapterPort (a satellite's channel adapter factory,
// `{ manifest: ChannelAdapterManifestEntry; create(): ChannelAdapterPort }`)
// and the `channel?` facet below are removed. Both are typed by the channel
// backplane, which is not core, and nothing in the donor tree at e6a9546
// references either declaration.
export interface SatelliteAdapterPort {
  id: string;
  routing?: SatelliteRoutingPort;
  presence?: SatellitePresencePort;
}

export function createNoopSatelliteRoutingPort(): SatelliteRoutingPort {
  return {
    evaluateDelegation: () => undefined,
  };
}

export function createActiveEmanationSatellitePresencePort(): SatellitePresencePort {
  return {
    resolveCanonicalEmbodiment(value) {
      return resolveCanonicalEmbodimentContext(value);
    },
    resolveCanonicalSatellite(value) {
      return resolveCanonicalSatelliteContext(value);
    },
  };
}
