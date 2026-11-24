/**
 * The single place the lifecycle bridge reaches `@cgic/psfn-core`. Every bridge
 * module imports companion core types and values from here, governed by
 * `tests/boundary/host-imports.test.ts`.
 */
export {
  NonRecoverableFallbackError,
  resolveExplicitToolContract,
  buildExactToolArgumentsModelSchema,
  createTurnId,
  externalMemorySessionId,
  getRequestContext,
  HostedAutomataExecutor,
  type SubstrateStreamTransport,
  type LLMProviderStreamOptions,
  type AgentResponse,
  type LLMContext,
  type LLMResponse,
  type StreamCallbacks,
  type SubstrateMessage,
  type ToolCall,
  type TurnRecord,
  type MemoryDeletionApprovalPort,
  type MemoryDeletionApprovalRequest,
  type MemoryDeletionApprovalResult,
  type MemoryDeletionProposalStorePort,
  type HostedAttemptClaim,
  type HostedAttemptRefusal,
  type HostedAttemptReport,
  type HostedAutomataPolicy,
  type HostedResult,
} from '@cgic/psfn-core/lifecycle';
