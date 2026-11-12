/**
 * PSFN Lite standalone: a thin host over the extracted companion core
 * (packages/companion `startCompanionRuntime`), with the Pi model adapter,
 * the donor's embedding providers, the MCP tool transport and the lifecycle bridge, and
 * its command line.
 */
export { SEED_FILES, runCli, type CliIo } from './cli.ts';
export { EMBEDDING_PROVIDER_KINDS, TRUST_LEVELS, parseLiteConfig, readSecrets, type LiteConfig, type LiteContact, type LiteSecrets } from './config.ts';
export {
  HOST_MODEL_ENTRY,
  LITE_CONTACT_CHANNEL,
  OPERATOR_CONTACT,
  createLiteRuntime,
  operatorChannelId,
  type LiteDiagnostic,
  type LiteRuntime,
  type LiteRuntimeOverrides,
} from './runtime.ts';
export { DONOR_TEXT_EMOTION_CACHE_DIR, buildSubstrateConfig, embeddingSettings, textEmotionCacheDir, type HostModelChoice } from './substrate-config.ts';
export {
  parseModelServiceConfig,
  remoteTextEmotionPipeline,
  startModelService,
  type ModelService,
  type ModelServiceConfig,
  type ModelServicePorts,
} from './model-service.ts';
