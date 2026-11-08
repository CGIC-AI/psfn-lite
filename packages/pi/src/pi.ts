/**
 * The Pi version-coupling boundary: the only module that imports the Pi
 * packages. It re-exports the public surface the harness uses (the low-level
 * agent loop, the tool contract, the model collection and the schema
 * builder). Nothing here reaches Pi internals; a Pi upgrade is audited
 * against this list.
 */
export { runAgentLoop } from '@earendil-works/pi-agent-core';
export type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, AgentToolResult, StreamFn } from '@earendil-works/pi-agent-core';
export { Type, createModels } from '@earendil-works/pi-ai';
export type { Api, AssistantMessage, Context, Message, Model, Models, SimpleStreamOptions, TextContent, Usage, UserMessage } from '@earendil-works/pi-ai';
export { builtinProviders } from '@earendil-works/pi-ai/providers/all';
