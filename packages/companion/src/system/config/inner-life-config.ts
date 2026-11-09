// ── Inner-life policy loader ──
//
// Lite extraction (seam 3.10). The donor loads its policy files through the
// general owner-file config store (config-store.ts, startup-owner-files.ts)
// and its settings pipeline (system/settings/io.ts, schema.ts,
// schema-runtime-normalization.ts, runtime.ts applyCoreSettings), which also
// own the gateway, fleet, channel, voice, image and Garden files. Lite loads
// only the inner-life policy files, through the same donor policy modules,
// unchanged:
//
// - scheduler.json       loadSchedulerConfig (scheduler-config.ts), read at the
//                        companion data root (donor config-store.ts:195);
// - trust-policy.json    loadTrustPolicyConfig (trust-policy-config.ts), system
//                        data root (config-store.ts:217);
// - subagent-roles.json  loadSubagentRolesConfig (subagent-roles-config.ts,
//                        promoted), system data root (config-store.ts:202);
// - automata-policy.json loadAutomataPolicyConfig below, system data root
//                        (config-store.ts:204);
// - settings.json        the inner-life policy keys only, normalised by the
//                        closure normalisers with the donor defaults.
//
// The settings, automata and reviewer-model pieces are copies of donor code at
// e6a9546, cited where they appear. No tunable value is defined here.

import { join } from 'node:path';
import {
  parseAutomataOwnerPolicy,
  type AutomataOwnerPolicy,
} from '../../faculties/automata/registry-contract.js';
import type { SubagentRoleRegistryConfig } from '../../faculties/subagents/role-registry.js';
import type { CanonicalModelRegistry } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  createDefaultBiographicalCandidatePolicy,
  normalizeBiographicalCandidatePolicy,
} from './biographical-candidate-policy.js';
import {
  createDefaultBiographicalDepthPolicy,
  normalizeBiographicalDepthPolicy,
} from './biographical-depth-policy.js';
import {
  createDefaultEmotionScopingSettings,
  normalizeEmotionScopingSettings,
} from './emotion-scoping-config.js';
import {
  createDefaultGroupMemorySettings,
  normalizeGroupMemorySettings,
} from './group-memory-config.js';
import { loadRequiredJson, loadSeedJson } from './load-or-seed.js';
import { normalizeMemoryDeletionPolicy } from './memory-deletion-policy.js';
import {
  createDefaultMemoryPresentationProfile,
  normalizeMemoryPresentationProfile,
} from './memory-presentation-profile.js';
import {
  createDefaultMemoryRetrievalPolicy,
  normalizeMemoryRetrievalPolicy,
} from './memory-retrieval-policy.js';
import {
  createDefaultNarrativeEmotionAppraisalSettings,
  normalizeNarrativeEmotionAppraisalSettings,
} from './narrative-emotion-appraisal-config.js';
import {
  createDefaultCompositionalPolicyConfig,
  createDefaultEmoSimProactivitySettings,
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from './runtime-config-contracts.js';
import { loadSchedulerConfig, type SchedulerRuntimeConfig } from './scheduler-config.js';
import { loadSubagentRolesConfig } from './subagent-roles-config.js';
import { loadTrustPolicyConfig, type TrustPolicyConfig } from './trust-policy-config.js';

/** Donor system/settings/contracts.ts:22 and system/settings/io.ts:20. */
export const SETTINGS_FILE_NAME = 'settings.json';
export const SETTINGS_SEED_FILE_NAME = 'settings.seed.json';

/** Donor system/config/automata-reviewer-model-contract.ts:5 and automata-policy-config.ts:12. */
export const AUTOMATA_FILE_NAME = 'automata-policy.json';
export const AUTOMATA_SEED_FILE_NAME = 'automata-policy.seed.json';

/** The SubstrateConfig fields that settings.json supplies to the inner-life loops. */
export type InnerLifePolicySettings = Required<Pick<SubstrateConfig,
  | 'groupMemory'
  | 'emotionScoping'
  | 'narrativeEmotionAppraisal'
  | 'memoryRetrievalPolicy'
  | 'biographicalDepthPolicy'
  | 'biographicalCandidatePolicy'
  | 'memoryPresentationProfile'
  | 'compositionalPolicy'
  | 'observerEvalSidecar'
  | 'emosimProactivity'
>> & Pick<SubstrateConfig, 'memoryDeletionPolicy'>;

export interface InnerLifeConfig {
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  subagentRoles: SubagentRoleRegistryConfig;
  automataPolicy: AutomataOwnerPolicy;
  settings: InnerLifePolicySettings;
}

export interface InnerLifeConfigLoadOptions {
  /** System data root (donor OwnerFileConfigStoreOptions.dataDir). */
  dataDir: string;
  /** Companion data root for per-companion files; defaults to dataDir (donor config-store.ts:176). */
  companionDataDir?: string;
  /** Seed directory; each donor loader falls back to CONFIG_DIR, then ./config. */
  seedDir?: string;
  /**
   * The host's model registry. The donor read it from models.json
   * (automata-policy-config.ts:26); Lite has no models owner file, so the host
   * supplies it. Only an enabled automata reviewer reads it.
   */
  modelRegistry?: CanonicalModelRegistry;
}

/** Load every inner-life policy file. Each missing or invalid file fails closed, as in the donor. */
export function loadInnerLifeConfig(options: InnerLifeConfigLoadOptions): InnerLifeConfig {
  const loadOptions = options.seedDir ? { seedDir: options.seedDir } : undefined;
  const companionDataDir = options.companionDataDir ?? options.dataDir;
  return {
    scheduler: loadSchedulerConfig(companionDataDir, loadOptions),
    trustPolicy: loadTrustPolicyConfig(options.dataDir, loadOptions),
    subagentRoles: loadSubagentRolesConfig(options.dataDir, loadOptions),
    automataPolicy: loadAutomataPolicyConfig(options.dataDir, {
      ...loadOptions,
      ...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
    }),
    settings: loadInnerLifePolicySettings(options.dataDir, loadOptions),
  };
}

/**
 * settings.json, inner-life policy keys only. The donor loaded the whole file
 * fail-closed with the seed as the example path (system/settings/io.ts:41-66),
 * normalised each present policy key with its policy module
 * (schema-runtime-normalization.ts:961-978, :1549-1577) and applied it over the
 * load-config defaults (load-config.ts:523-533, :626-627; settings/runtime.ts
 * applyCoreSettings :787-826). Every other settings.json key belongs to a cut
 * subsystem or to the host composition and is ignored here.
 */
export function loadInnerLifePolicySettings(
  dataDir: string,
  options: { seedDir?: string } = {},
): InnerLifePolicySettings {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, SETTINGS_FILE_NAME),
    examplePath: join(seedDir, SETTINGS_SEED_FILE_NAME),
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return normalizeInnerLifePolicySettings(raw);
    },
  });
}

function normalizeInnerLifePolicySettings(
  settings: Record<string, unknown>,
): InnerLifePolicySettings {
  const memoryDeletionPolicy = 'memoryDeletionPolicy' in settings
    ? normalizeMemoryDeletionPolicy(settings.memoryDeletionPolicy, 'memoryDeletionPolicy')
    : undefined;
  return {
    groupMemory: 'groupMemory' in settings
      ? normalizeGroupMemorySettings(settings.groupMemory, 'groupMemory')
      : createDefaultGroupMemorySettings(),
    emotionScoping: 'emotionScoping' in settings
      ? normalizeEmotionScopingSettings(settings.emotionScoping, 'emotionScoping')
      : createDefaultEmotionScopingSettings(),
    narrativeEmotionAppraisal: 'narrativeEmotionAppraisal' in settings
      ? normalizeNarrativeEmotionAppraisalSettings(
        settings.narrativeEmotionAppraisal,
        'narrativeEmotionAppraisal',
      )
      : createDefaultNarrativeEmotionAppraisalSettings(),
    memoryRetrievalPolicy: 'memoryRetrievalPolicy' in settings
      ? normalizeMemoryRetrievalPolicy(settings.memoryRetrievalPolicy, 'memoryRetrievalPolicy')
      : createDefaultMemoryRetrievalPolicy(),
    biographicalDepthPolicy: 'biographicalDepthPolicy' in settings
      ? normalizeBiographicalDepthPolicy(settings.biographicalDepthPolicy, 'biographicalDepthPolicy')
      : createDefaultBiographicalDepthPolicy(),
    biographicalCandidatePolicy: 'biographicalCandidatePolicy' in settings
      ? normalizeBiographicalCandidatePolicy(
        settings.biographicalCandidatePolicy,
        'biographicalCandidatePolicy',
      )
      : createDefaultBiographicalCandidatePolicy(),
    ...(memoryDeletionPolicy ? { memoryDeletionPolicy } : {}),
    memoryPresentationProfile: 'memoryPresentationProfile' in settings
      ? normalizeMemoryPresentationProfile(
        settings.memoryPresentationProfile,
        'memoryPresentationProfile',
      )
      : createDefaultMemoryPresentationProfile(),
    // The donor normalisers for these three keys live in the settings schema
    // (schema-runtime-normalization.ts:411-806), outside
    // the core. Lite uses the load-config defaults (load-config.ts:625-627);
    // the shipped settings seed normalises to exactly these values.
    compositionalPolicy: createDefaultCompositionalPolicyConfig(),
    observerEvalSidecar: createDefaultObserverEvalSidecarSettings(),
    emosimProactivity: createDefaultEmoSimProactivitySettings(),
  };
}

/**
 * Copy of donor system/config/automata-policy-config.ts:14-29 at e6a9546, with
 * the models.json read replaced by the host-supplied registry.
 */
export function loadAutomataPolicyConfig(
  dataDir: string,
  options: { seedDir?: string; modelRegistry?: CanonicalModelRegistry } = {},
): AutomataOwnerPolicy {
  const dataPath = join(dataDir, AUTOMATA_FILE_NAME);
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const policy = loadRequiredJson({
    dataPath,
    examplePath: join(seedDir, AUTOMATA_SEED_FILE_NAME),
    validate: (raw, sourcePath) => parseAutomataOwnerPolicy(raw, sourcePath),
  });
  if (policy.bus.reviewer.enabled) {
    assertAutomataReviewerModelResolvable(policy, options.modelRegistry ?? { schemaVersion: 1, models: [] });
  }
  return policy;
}

/**
 * Copy of donor system/config/automata-policy-config.ts:31-39 at e6a9546: the
 * shipped seed policy, parsed, without reading or writing the data root.
 */
export function loadAutomataPolicySeedDefaults(
  options: { seedDir?: string } = {},
): AutomataOwnerPolicy {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadSeedJson({
    seedPath: join(seedDir, AUTOMATA_SEED_FILE_NAME),
    validate: (raw, sourcePath) => parseAutomataOwnerPolicy(raw, sourcePath),
  });
}

/** Copy of donor system/config/automata-reviewer-model-contract.ts:7-21 at e6a9546. */
export function assertAutomataReviewerModelResolvable(
  policy: AutomataOwnerPolicy,
  modelRegistry: CanonicalModelRegistry,
): void {
  if (!policy.bus.reviewer.enabled) return;
  const slots = listEnabledModelRegistrySlotKeys({ modelRegistry });
  if (!slots.includes(policy.bus.reviewer.model)) {
    throw new Error(
      `${AUTOMATA_FILE_NAME}.bus.reviewer.model references slot "${policy.bus.reviewer.model}", `
      + 'which is not an enabled models.json registry entry. '
      + `Select an enabled slot (${slots.join(', ') || 'none'}) or disable the reviewer.`,
    );
  }
}

/** Copy of donor system/config/model-selection-config.ts:93-99 at e6a9546. */
export function listEnabledModelRegistrySlotKeys(
  config: Pick<SubstrateConfig, 'modelRegistry'>,
): string[] {
  return (config.modelRegistry?.models ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.id);
}
