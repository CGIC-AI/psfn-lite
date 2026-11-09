/**
 * PSFN Lite lifecycle bridge for external companion hosts. A host such as
 * Hermes runs its own model loop; the bridge gives it host-driven companion
 * turns that are the donor's turns: the extracted SubstrateAgent assembles the
 * context, runs every tool call, archives the turn and schedules its
 * post-turn work, and only the model's answers come from the host (through
 * the donor's stream transport seam). The caller is bound from the same
 * transport credentials the MCP tool transport uses.
 */
export {
  HostTurnBridge,
  type BoundContact,
  type CheckpointAnswer,
  type HostOutcome,
  type HostTurnBridgeOptions,
  type PrepareAnswer,
  type PrepareInput,
  type SettleAnswer,
  type SettleInput,
} from './bridge.ts';
export {
  HostTurn,
  HostTurnRelay,
  hostContextOf,
  type HostContextMessage,
  type HostToolSchema,
  type HostTurnAgent,
  type HostTurnContext,
  type HostTurnEnd,
  type OpenOutcome,
  type ToolRelayResult,
} from './host-turns.ts';
export { LIFECYCLE_PATH, startLifecycleBridge, type LifecycleBridge, type LifecycleBridgeOptions, type LifecycleErrorReport } from './http.ts';
export { createHostToolPort, donorToolDefinitions, type DonorTool, type DonorToolCatalog } from './tools.ts';
