import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { createJournalTool } from '../../../boundary/integrations/journal/tools.js';
import { createAutomataBusTool } from '../../../faculties/automata/bus/worker-access.js';
import { createContactTool } from '../../contacts/tools.js';
import { createIdentityTool } from '../../identity/prompt-tools.js';
import { createScheduleTool } from '../../scheduler/schedule-tool.js';
import { createSessionTool } from '../../tools/session.js';
import { createLetterTool } from '../../tools/letter.js';
import { createOrientTool } from '../../../faculties/core-memory/tools.js';
import { createMemoryTool } from '../../../faculties/memory/tools.js';
import { createScratchpadTool } from '../../../faculties/memory/tools/scratchpad.js';
import { createNorthStarTool } from '../../../faculties/north-star/tools.js';
import { createSubagentTool } from '../../../faculties/subagents/tools.js';
import { createResponseControlTool } from '../no-reply-tool.js';
import { createToolSearchTool, createToolsetTool } from '../substrate-agent/adaptive-tools-runtime.js';
import { INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME } from '../../session/intake-sink-gating.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';

function testBound(value: string): number {
  return Number.parseInt(value, 10);
}

function testSensitivity(value: SensitivityLevel): SensitivityLevel {
  return value;
}

export function createProviderFactoryToolCatalog(): AgentTool<any>[] {
  const inert = {} as never;
  const automataBus = createAutomataBusTool({
    access: {
      identity: {
        companionId: 'companion-public-example',
        audience: 'eligible-automata',
        maxSensitivity: testSensitivity('personal'),
      },
      bounds: {
        maxQueryChars: testBound('100'),
        maxTextChars: testBound('200'),
        maxArrayItems: testBound('8'),
        maxSearchResults: testBound('8'),
        maxRunResults: testBound('16'),
        maxBriefingChars: testBound('200'),
        maxBriefingItems: testBound('4'),
        maxToolResultChars: testBound('1000'),
      },
      port: {
        isClassEligible: () => true,
        brief: inert,
        search: inert,
        append: inert,
        correct: inert,
        handoff: inert,
        runs: inert,
        inspect: inert,
      },
    },
    scope: {
      companionId: 'companion-public-example',
      runId: 'run-public-example',
      taskId: 'task-public-example',
      automatonClass: 'subagent.bounded',
      audience: 'eligible-automata',
      maxSensitivity: testSensitivity('personal'),
    },
  });
  return [
    createToolSearchTool(inert), createToolsetTool(inert),
    createResponseControlTool(() => null),
    createOrientTool(inert), createIdentityTool(inert, {
      intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
    }),
    createMemoryTool(inert, inert), automataBus, createScratchpadTool(inert), createContactTool(inert, {
      intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
    }),
    createSessionTool(inert), createLetterTool(inert),
    createScheduleTool(inert),
    createNorthStarTool(inert), createSubagentTool(inert),
    createJournalTool(inert),
  ];
}
