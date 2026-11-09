/**
 * The single place the lifecycle bridge reaches the extracted companion core
 * (packages/companion). Every bridge module imports donor types and values from
 * here, so the boundary test can list exactly which donor modules a host
 * adapter depends on.
 */
export type { SubstrateStreamTransport } from '../../companion/src/core/agent/stream-adapter.js';
export type { LLMProviderStreamOptions } from '../../companion/src/core/agent/contracts.js';
export type {
  AgentResponse,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateMessage,
  ToolCall,
} from '../../companion/src/shared/contracts/runtime-base.js';
export type { TurnRecord } from '../../companion/src/shared/contracts/runtime.js';
export { NonRecoverableFallbackError } from '../../companion/src/primitives/llm/fallback.js';
export { createTurnId } from '../../companion/src/core/turns/id.js';
export { externalMemorySessionId } from '../../companion/src/shared/contracts/external-memory.js';
export { getRequestContext } from '../../companion/src/primitives/llm/request-context.js';
export type {
  MemoryDeletionApprovalPort,
  MemoryDeletionApprovalRequest,
  MemoryDeletionApprovalResult,
  MemoryDeletionProposalStorePort,
} from '../../companion/src/faculties/memory/deletion-proposals.js';
export {
  HostedAutomataExecutor,
  type HostedAttemptClaim,
  type HostedAttemptRefusal,
  type HostedAttemptReport,
  type HostedAutomataPolicy,
  type HostedResult,
} from '../../companion/src/faculties/subagents/host-execution.js';
