/**
 * PSFN Lite lifecycle bridge for external companion hosts. A host such as
 * Hermes prepares, settles and checkpoints its turns through core's turn
 * lifecycle over this authenticated HTTP JSON surface, and claims the
 * internal turns core delegates to it. The caller is bound from the same
 * transport credentials the MCP tool transport uses; every route calls one
 * core use case. Core imports nothing from here.
 */
export { createDelegatedInternalTurns, type DelegatedInternalTurns, type DelegatedJob, type DelegatedOptions } from './delegated.ts';
export {
  LIFECYCLE_PATH,
  abandonDelegatedTurn,
  delegatedOwner,
  hostOwner,
  startLifecycleBridge,
  type LifecycleBridge,
  type LifecycleBridgeOptions,
  type LifecycleErrorReport,
} from './http.ts';
