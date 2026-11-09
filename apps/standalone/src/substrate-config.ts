/**
 * The substrate config the companion core runs with. The donor built it in
 * load-config.ts (loadAgentConfig: the defaults at :76-129 assembled at
 * :497-565) and applied settings.json over it (settings/runtime.ts
 * applyCoreSettings). This is the same assembly for the kept subsystems:
 * the donor's core defaults, then the scalar settings.json values from the
 * data directory (the policy objects of settings.json are the inner-life
 * owner files the core loads itself), then this host's choices (model,
 * embedding, database, paths). The defaults of cut subsystems (voice,
 * Discord, images, shards, document ingest, the analysis workbench, web and
 * filesystem tools, Wyoming, Telegram, Home Assistant) are not set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANION_SEED_DIR,
  DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  createDefaultBiographicalCandidatePolicy,
  createDefaultBiographicalDepthPolicy,
  createDefaultCompositionalPolicyConfig,
  createDefaultEmoSimProactivitySettings,
  createDefaultEmotionScopingSettings,
  createDefaultGroupMemorySettings,
  createDefaultMemoryPresentationProfile,
  createDefaultMemoryRetrievalPolicy,
  createDefaultNarrativeEmotionAppraisalSettings,
  createDefaultObserverEvalSidecarSettings,
  createDefaultSessionTailCacheSettings,
  type SubstrateConfig,
} from './companion.ts';
import type { LiteConfig } from './config.ts';

/** Donor load-config.ts:64-75. */
const MODEL_ROLE_ASSIGNMENTS = {
  chat: 'primary',
  background: 'extraction',
  memory: 'extraction',
  context: 'extraction',
  extraction: 'extraction',
  summary: 'primary',
  reasoning: 'primary',
  longContext: 'primary',
  vision: 'primary',
  import_processing: 'extraction',
} as const;

/** Donor load-config.ts:76-129 and :497-565, kept subsystems only. */
function donorCoreDefaults(): Record<string, unknown> {
  return {
    sessionMessageLimit: 30,
    sessionRestartBehavior: 'reuse_latest_session',
    continuityMessageLimit: 10,
    sessionHistoryBudgetPct: SESSION_HISTORY_BUDGET_PCT_DEFAULT,
    memoryRetrievalBudgetPct: MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
    moodCongruenceWeight: DEFAULT_MOOD_CONGRUENCE_WEIGHT,
    adaptiveContextBudgetsEnabled: false,
    sessionMirrorEnabled: true,
    sessionMirrorMaxChars: 220,
    sessionMirrorActiveWindowMs: 1_800_000,
    sessionMirrorChannelOverrides: {},
    extractionInterval: 5,
    maintenanceIntervalMs: 3_600_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    observationMaskingWindow: 1,
    compactionEmotionalSalienceThresholdPct: 75,
    memoryExtractionMinImportance: 0.45,
    memoryExtractionMinConfidence: 0.6,
    memoryExtractionMinNovelty: 0.35,
    memoryExtractionEmotionalIntensityWeight: 0.2,
    memoryExtractionMaxWrites: 2,
    memoryExtractionTelemetryEnabled: true,
    memoryRetrievalTelemetryEnabled: true,
    memoryRetrievalPolicy: createDefaultMemoryRetrievalPolicy(),
    biographicalDepthPolicy: createDefaultBiographicalDepthPolicy(),
    biographicalCandidatePolicy: createDefaultBiographicalCandidatePolicy(),
    memoryPresentationProfile: createDefaultMemoryPresentationProfile(),
    memoryRefreshFailureAlertThreshold: 3,
    activeMemoryRetrievalMode: 'background',
    activeMemoryInlineBudgetMs: 2_000,
    groupMemory: createDefaultGroupMemorySettings(),
    emotionScoping: createDefaultEmotionScopingSettings(),
    narrativeEmotionAppraisal: createDefaultNarrativeEmotionAppraisalSettings(),
    profileSynthesisEnabled: true,
    profileSynthesisRefreshIntervalMs: 6 * 60 * 60 * 1000,
    profileSynthesisCooldownMs: 5 * 60 * 1000,
    profileSynthesisMinWrites: 1,
    profileSynthesisMinImportance: 0.65,
    profileSynthesisMinConfidence: 0.7,
    profileSynthesisMinNovelty: 0.12,
    profileSynthesisSourceMemoryLimit: 16,
    profileSynthesisMinSourceMemories: 2,
    subagentMaxConcurrent: 8,
    modelRoleAssignments: { ...MODEL_ROLE_ASSIGNMENTS },
    characterName: '',
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2_000,
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    emosimProactivity: createDefaultEmoSimProactivitySettings(),
    sessionTailCache: createDefaultSessionTailCacheSettings(),
  };
}

/** The owner's settings.json (the shipped seed until `init` copies it), scalar values only. */
function settingsScalars(dataDir: string): Record<string, unknown> {
  const owned = join(dataDir, 'settings.json');
  const path = existsSync(owned) ? owned : join(fileURLToPath(COMPANION_SEED_DIR), 'settings.seed.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value === null || typeof value !== 'object'));
}

/** The donor's seeded text-emotion model cache (config/settings.seed.json `textEmotionCacheDir`). */
export const DONOR_TEXT_EMOTION_CACHE_DIR = 'models/transformers';

/**
 * Where the text-emotion classifier keeps its model. The donor set it in
 * settings.json (`textEmotionCacheDir`, seeded `models/transformers`;
 * settings/runtime.ts applyTrimmedSetting) and handed it to transformers.js
 * as is (core/emotion/text-classifier.ts `env.cacheDir`), so a relative value
 * resolved against the working directory: the donor repository root, whose
 * `/models/` it gitignored. A Lite host runs from wherever it is started (the
 * 2026-11-09 shakedown downloaded the 478 MB model into a source checkout),
 * so the same setting is read from the owner's settings.json and a relative
 * value resolves under the data directory. An absolute value is kept.
 */
export function textEmotionCacheDir(dataDir: string, value: unknown): string {
  const chosen = typeof value === 'string' && value.trim() !== '' ? value.trim() : DONOR_TEXT_EMOTION_CACHE_DIR;
  return isAbsolute(chosen) ? chosen : resolve(dataDir, chosen);
}

export interface HostModelChoice {
  readonly modelId: string;
  readonly provider: string;
  readonly maxOutputTokens: number;
  readonly contextWindow: number;
  /** The one `models.json` registry entry routing every purpose to the host model. */
  readonly registry: { readonly models: readonly unknown[] };
}

export function buildSubstrateConfig(config: LiteConfig, input: { readonly databaseUrl: string; readonly model: HostModelChoice }): SubstrateConfig {
  const { model } = input;
  const settings = settingsScalars(config.dataDir);
  return {
    ...donorCoreDefaults(),
    ...settings,
    textEmotionCacheDir: textEmotionCacheDir(config.dataDir, settings['textEmotionCacheDir']),
    primaryModel: model.modelId,
    primaryProvider: model.provider,
    extractionModel: model.modelId,
    extractionProvider: model.provider,
    primaryMaxTokens: model.maxOutputTokens,
    extractionMaxTokens: model.maxOutputTokens,
    defaultContextWindow: model.contextWindow,
    modelRegistry: model.registry,
    modelRoster: {
      chat: { model: model.modelId, provider: model.provider, maxTokens: model.maxOutputTokens, contextWindow: model.contextWindow },
      background: { model: model.modelId, provider: model.provider, maxTokens: model.maxOutputTokens },
      memory: { model: model.modelId, provider: model.provider, maxTokens: model.maxOutputTokens },
      context: { model: model.modelId, provider: model.provider, maxTokens: model.maxOutputTokens },
    },
    characterCardPath: config.characterCardPath,
    dataDir: config.dataDir,
    databasePath: join(config.dataDir, 'substrate.db'),
    companionId: config.companionId,
    persistenceBackend: 'postgres',
    postgresDatabaseUrl: input.databaseUrl,
    embeddingProvider: 'api',
    embeddingApiModel: config.embedding.model,
    embeddingApiDims: config.embedding.dimensions,
  } as SubstrateConfig;
}
