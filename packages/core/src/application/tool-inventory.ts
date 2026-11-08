import { activityTool } from '../activity/index.ts';
import { automataTool } from '../automata/index.ts';
import { contactTool } from '../contacts/index.ts';
import { emotionTool } from '../emotion/index.ts';
import { episodeTool } from '../episodes/index.ts';
import { orientTool, valuesTool } from '../identity/index.ts';
import { concernTool } from '../intention/index.ts';
import { journalTool } from '../journals/index.ts';
import { memoryTool } from '../memory/index.ts';
import { freeTimeTool } from '../scheduler/index.ts';
import { sessionTool } from '../sessions/index.ts';
import {
  deepFreeze,
  invalid,
  ok,
  type ActionDescriptor,
  type Result,
  type ToolDescriptor,
} from '../shared/index.ts';

/** Donor framework revision every `donor` mapping in the inventory refers to. */
export const DONOR_REVISION = 'e6a9546051f4e92bf7218b133b4523ac53a797c0';

/**
 * The complete model-facing tool surface: one semantic tool per domain area,
 * each owned by exactly one domain. Native harnesses and tool transports
 * expose this same list; neither defines tools of its own.
 */
export const TOOL_INVENTORY: readonly ToolDescriptor[] = deepFreeze([
  orientTool,
  valuesTool,
  memoryTool,
  sessionTool,
  episodeTool,
  journalTool,
  contactTool,
  emotionTool,
  concernTool,
  activityTool,
  automataTool,
  freeTimeTool,
]);

export interface ResolvedAction {
  readonly tool: ToolDescriptor;
  readonly action: ActionDescriptor;
}

/** Looks up an action; unknown tools and actions are rejected, never defaulted. */
export function resolveAction(
  inventory: readonly ToolDescriptor[],
  toolName: string,
  actionName: string,
): Result<ResolvedAction> {
  const tool = inventory.find((candidate) => candidate.name === toolName);
  if (tool === undefined) return invalid(`unknown tool ${toolName}`);
  const action = tool.actions.find((candidate) => candidate.name === actionName);
  if (action === undefined) return invalid(`unknown action ${toolName}.${actionName}`);
  return ok({ tool, action });
}
