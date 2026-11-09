/**
 * PSFN Lite standalone: a thin host over the extracted companion core
 * (packages/companion `startCompanionRuntime`), with the Pi model and
 * embedding adapters, the MCP tool transport and the lifecycle bridge, and
 * its command line.
 */
export { SEED_FILES, runCli, type CliIo } from './cli.ts';
export { TRUST_LEVELS, parseLiteConfig, readSecrets, type LiteConfig, type LiteContact, type LiteSecrets } from './config.ts';
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
export { buildSubstrateConfig, type HostModelChoice } from './substrate-config.ts';
