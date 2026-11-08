// ── Scaffolding fields of SubstrateConfig (TEMPORARY, vendored) ──
//
// Lite extraction, seam 3.10. These SubstrateConfig fields and declarations
// belong to cut subsystems (gateway, fleet auth, CogSec screening, kube
// lifecycle, wiki hydration, shards and satellites, file ingest, images,
// voice, channel triggers, the operator Garden, the analysis workbench and
// the host tool integrations). No core file reads them (each field has zero
// readers in the core tree; see packages/companion/extraction/cuts.tsv), so
// they were cut from the core contract in runtime-config-contracts.ts.
// The vendored scaffolding that still reads them compiles through this module
// augmentation; the file is vendored scaffolding and leaves with it in B7.
//
// Field and declaration text copied verbatim from the donor at e6a9546:
// src/system/config/runtime-config-contracts.ts.

import type {
  FalCreateModel,
  FalEditModel,
  ImageProvider,
  ImageWorkflowSettings,
} from '../../primitives/images/types.js';
import type { StreamingSttProvider } from '../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsProvider } from '../../primitives/voice/connectors/tts/index.js';
import type { CompanionRuntimeIdentity } from './companions-config.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type {
  FleetAuthConfig,
  FleetAuthVerifierConfig,
} from './fleet-auth-config.js';
import type { CogSecPersonaConformanceSettings } from '../../shared/contracts/cogsec-persona-conformance.js';
import type { CapabilityTier } from '../capabilities/tier-types.js';

export type ShardToolsetConfig = Partial<Record<CapabilityTier, string[]>>;

export interface WyomingShardRoutingConfig {
  enabled: boolean;
  siteAllowlist?: string[];
  satelliteAllowlist?: string[];
}

export interface VoiceReplySegmenterSettings {
  minSegmentLength: number;
  maxBufferLength: number;
}

export interface WikiStartupHydrationSettings {
  recentSessionLimit: number;
  recentMessageLimit: number;
  maxContextChars: number;
}

/**
 * Mutable operational limits for lifecycle commands and the Kubernetes
 * self-management surfaces. Network coordinates and credentials remain
 * environment-owned; immutable protocol and response-size guards remain code-owned.
 */
export interface LifecycleKubernetesSettings {
  lifecycleCommandTimeoutMs: number;
  operatorCommandTimeoutMs: number;
  operatorHttpTimeoutMs: number;
  operatorConfirmationRequestTimeoutMs: number;
  kubernetesReadRequestTimeoutMs: number;
  kubernetesRolloutRequestTimeoutMs: number;
  rolloutWaitTimeoutMs: number;
  rolloutPollIntervalMs: number;
  rollbackWaitTimeoutMs: number;
  rollbackPollIntervalMs: number;
  postRolloutMaxLogRecords: number;
  postRolloutValidationHistoryLimit: number;
  rollbackHistoryLimit: number;
}

declare module './runtime-config-contracts.js' {
  interface SubstrateConfig {
    /** Fleet-bound process identity for an agent/gateway using fleet routing. */
    companionRuntimeIdentity?: CompanionRuntimeIdentity;
    /** Per-companion proof used only during gateway connection authentication. */
    gatewayCompanionAuthToken?: string;
    /** Role-bound proof delegated only to the session-integrity worker. */
    gatewaySessionIntegrityAuthToken?: string;
    /** Gateway-only full owner-file projection; never present in agent/operator config. */
    fleetAuth?: FleetAuthConfig;
    /** Public-key-only projection supplied to operator/agent verifier processes. */
    fleetAuthVerifier?: FleetAuthVerifierConfig;
    /** settings.json-owned startup wiki cache hydration volume. */
    wikiStartupHydration?: WikiStartupHydrationSettings;
    /** settings.json-owned lifecycle and Kubernetes operational policy. */
    lifecycleKubernetes?: LifecycleKubernetesSettings;
    /** Per-companion JSON-owned baseline for CogSec persona drift detection. */
    cogSecPersonaConformance?: CogSecPersonaConformanceSettings;
    /**
     * Fail-closed intake screening events per stage/source class before one
     * deduplicated operator alert is raised. Owned by settings.json.
     */
    intakeScreeningFailureAlertThreshold?: number;
    shardToolsets?: ShardToolsetConfig;
    /** Concurrency cap on simultaneously active shards (zet.7). */
    shardMaxConcurrent?: number;
    /** Shard heartbeat silence (ms) before a shard is marked degraded/stale (zet.7). */
    shardHeartbeatStaleAfterMs?: number;
    /** Shard heartbeat silence (ms) before a shard is marked offline (zet.7). */
    shardHeartbeatDisconnectAfterMs?: number;
    /** Satellite heartbeat silence (ms) before a hub device reads degraded (s7wq3). */
    satelliteHeartbeatStaleAfterMs?: number;
    /** Max document attachment size accepted by file ingest (bytes, zet.7). */
    documentIngestMaxBytes?: number;
    /** Max plain-text attachment size accepted by file ingest (bytes, zet.7). */
    documentIngestTextMaxBytes?: number;
    /** Char cap on parsed attachment text injected into the prompt (zet.7). */
    documentIngestPromptChars?: number;
    /** Char cap on parsed attachment text written to the sidecar file (zet.7). */
    documentIngestSidecarChars?: number;
    /** Overall wait cap (ms) for FAL image queue results (zet.7). */
    imageFalTimeoutMs?: number;
    /** Poll cadence (ms) for FAL image queue status (zet.7). */
    imageFalPollIntervalMs?: number;
    /** Overall wait cap (ms) for ComfyUI workflow completion (zet.7). */
    imageComfyTimeoutMs?: number;
    /** Poll cadence (ms) for ComfyUI workflow history (zet.7). */
    imageComfyPollIntervalMs?: number;
    voiceEnabled?: boolean;
    discordBackfillOnStartup?: boolean;
    discordTriggerWords?: string[];
    discordTriggerReactions?: string[];
    discordTriggerListenWindowMs?: number;
    uiThemeId?: string;
    voiceTargetGuildId?: string;
    voiceTargetUserId?: string;
    voiceReadyCueText?: string;
    voiceDaveEncryption?: boolean;
    voiceDecryptionFailureTolerance?: number;
    /** Idle-connection timeout for the voice websocket session before force-close. */
    voiceSessionTimeoutMs?: number;
    /** Maximum inbound voice websocket frame size (bytes) before rejection. */
    voiceMaxFrameBytes?: number;
    /** Backpressure cap on queued inbound voice frames before overflow close. */
    voiceMaxPendingFrames?: number;
    /** settings.json-owned committed voice reply segmentation thresholds. */
    voiceReplySegmenter?: VoiceReplySegmenterSettings;
    sttProvider?: StreamingSttProvider | 'disabled';
    ttsProvider?: StreamingTtsProvider | 'disabled';
    deepgramApiKey?: string;
    deepgramModel?: string;
    deepgramSttEndpoint?: string;
    deepgramListenEndpoint?: string;
    elevenLabsApiKey?: string;
    elevenLabsVoiceId?: string;
    elevenLabsModelId?: string;
    elevenLabsEndpointBase?: string;
    falApiKey?: string;
    comfyUiBaseUrl?: string;
    imageProvider?: ImageProvider;
    imageFalCreateModel?: FalCreateModel;
    imageFalEditModel?: FalEditModel;
    imageSelfieEditModel?: FalEditModel;
    imageWorkflows?: ImageWorkflowSettings;
    echoTtsUrl?: string;
    echoTtsVoice?: string;
    echoTtsPreset?: string;
    echoTtsModel?: string;
    analysisWorkbenchMaxTokens?: number;
    analysisWorkbenchMaxWallTimeMs?: number;
    /** Shared response-wait window for direct-parent Workbench execution. */
    analysisWorkbenchDirectResponseTimeoutMs?: number;
    analysisWorkbenchMaxSubQueries?: number;
    /** Operator override for the analysis workbench iteration cap (turns). */
    analysisWorkbenchMaxIterations?: number;
    /** Per-code-block sandbox execution timeout (ms) for the analysis workbench. */
    analysisWorkbenchExecutionTimeoutMs?: number;
    /** Character cap on a single analysis-workbench code execution's output. */
    analysisWorkbenchOutputTruncation?: number;
    webFetchAllowHttp?: boolean;
    webFetchDomainAllowlist?: string[];
    webFetchAllowInternalNetwork?: boolean;
    homeAssistantEnabled?: boolean;
    webFetchTlsCaCertPaths?: string[];
    /** Path to a CA certificate file (PEM) to trust for all outbound TLS connections (LLM, embeddings, etc.). Sets NODE_EXTRA_CA_CERTS at startup. */
    gatewayTlsCaPath?: string;
    /** Dev/test-only request for endpoint-scoped TLS verification exceptions. Rejected in production; never maps to NODE_TLS_REJECT_UNAUTHORIZED. */
    gatewayTlsRejectUnauthorized?: boolean;
    wyomingShardRouting?: WyomingShardRoutingConfig;
    wyomingEnabled?: boolean;
    wyomingHost?: string;
    wyomingPort?: number;
    telegramEnabled?: boolean;
    telegramAuthorizedUsers?: string[];
    obsidianVaultName?: string;
    obsidianCliPath?: string;
    obsidianAutoPublish?: boolean;
    obsidianTimeoutMs?: number;
    satelliteRegistry?: SatelliteRegistryConfig;
  }
}
