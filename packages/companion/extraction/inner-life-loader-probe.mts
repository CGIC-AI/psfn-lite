#!/usr/bin/env node
/**
 * Seam 3.10 equivalence probe: Lite's inner-life loader against the vendored
 * donor pipeline, both reading the shipped seeds as owner files.
 *
 *   npx tsx packages/companion/extraction/inner-life-loader-probe.mts
 *
 * Donor side: createOwnerFileConfigStore (system/config/config-store.ts) for the
 * four policy files, system/settings/io.ts loadSettings for settings.json, then
 * the load-config default where a key is absent (load-config.ts:523-533,
 * :625-627). Lite side: loadInnerLifeConfig, with the model registry from the
 * vendored loadModelsConfig. Prints one line per value and exits 1 on any
 * difference. It compares against vendored scaffolding, so it leaves in B7.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const src = (path: string) => join(pkg, 'src', path);
const seedDir = join(pkg, 'config');

const lite = await import(src('system/config/inner-life-config.ts'));
const store = await import(src('system/config/config-store.ts'));
const models = await import(src('system/config/models-config.ts'));
const io = await import(src('system/settings/io.ts'));
const contracts = await import(src('system/config/runtime-config-contracts.ts'));
const defaults: Record<string, () => unknown> = {
  groupMemory: (await import(src('system/config/group-memory-config.ts'))).createDefaultGroupMemorySettings,
  emotionScoping: (await import(src('system/config/emotion-scoping-config.ts'))).createDefaultEmotionScopingSettings,
  narrativeEmotionAppraisal: (await import(src('system/config/narrative-emotion-appraisal-config.ts')))
    .createDefaultNarrativeEmotionAppraisalSettings,
  memoryRetrievalPolicy: (await import(src('system/config/memory-retrieval-policy.ts'))).createDefaultMemoryRetrievalPolicy,
  biographicalDepthPolicy: (await import(src('system/config/biographical-depth-policy.ts'))).createDefaultBiographicalDepthPolicy,
  biographicalCandidatePolicy: (await import(src('system/config/biographical-candidate-policy.ts')))
    .createDefaultBiographicalCandidatePolicy,
  memoryPresentationProfile: (await import(src('system/config/memory-presentation-profile.ts')))
    .createDefaultMemoryPresentationProfile,
  memoryDeletionPolicy: () => undefined,
  compositionalPolicy: contracts.createDefaultCompositionalPolicyConfig,
  observerEvalSidecar: contracts.createDefaultObserverEvalSidecarSettings,
  emosimProactivity: contracts.createDefaultEmoSimProactivitySettings,
};

const dir = mkdtempSync(join(tmpdir(), 'lite-inner-life-'));
let failed = false;
const check = (name: string, liteValue: unknown, donorValue: unknown) => {
  const equal = isDeepStrictEqual(liteValue, donorValue);
  if (!equal) failed = true;
  console.log(`${name}\t${equal ? 'equal' : 'DIFFERENT'}`);
};
try {
  for (const file of ['scheduler', 'trust-policy', 'subagent-roles', 'automata-policy', 'settings', 'models']) {
    copyFileSync(join(seedDir, `${file}.seed.json`), join(dir, `${file}.json`));
  }
  const modelRegistry = models.loadModelsConfig(dir, { seedDir }).modelRegistry;
  const got = lite.loadInnerLifeConfig({ dataDir: dir, seedDir, modelRegistry });
  const donor = store.createOwnerFileConfigStore({ dataDir: dir, seedDir });
  check('scheduler.json', got.scheduler, donor.loadScheduler());
  check('trust-policy.json', got.trustPolicy, donor.loadTrustPolicy());
  check('subagent-roles.json', got.subagentRoles, donor.loadSubagentRoles());
  check('automata-policy.json', got.automataPolicy, donor.loadAutomataPolicy());
  const donorSettings = io.loadSettings(dir, { seedDir }) as Record<string, unknown>;
  for (const [key, createDefault] of Object.entries(defaults)) {
    const donorValue = key in donorSettings ? donorSettings[key] ?? createDefault() : createDefault();
    check(`settings.${key}`, (got.settings as Record<string, unknown>)[key], donorValue);
  }
  try {
    lite.loadInnerLifeConfig({ dataDir: dir, seedDir });
    failed = true;
    console.log('no registry\tloaded (expected the reviewer-model error)');
  } catch (error) {
    console.log(`no registry\t${(error as Error).message}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
