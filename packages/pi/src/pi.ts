/**
 * The Pi version-coupling boundary: the only module of this package that
 * imports the Pi packages. It re-exports the public surface the adapters use
 * (the model collection and its types). Nothing here reaches Pi internals; a
 * Pi upgrade is audited against this list.
 */
export { createModels } from '@earendil-works/pi-ai';
export type { Api, AssistantMessage, AssistantMessageEvent, AuthContext, AuthResult, Context, Model, Models, SimpleStreamOptions } from '@earendil-works/pi-ai';
export { builtinProviders } from '@earendil-works/pi-ai/providers/all';
