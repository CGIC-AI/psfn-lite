import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const SUBAGENT_TOOL = 'src/faculties/subagents/tools.ts';
const TASK_VISIBILITY = 'src/faculties/subagents/task-visibility.ts';

function workerRead(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'read',
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: ['visibility_gated'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [SUBAGENT_TOOL, TASK_VISIBILITY] },
  };
}

function workerControl(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: ['visibility_gated'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [SUBAGENT_TOOL, TASK_VISIBILITY] },
  };
}

export const automataTool = defineTool({
  name: 'automata',
  domain: 'automata',
  summary: 'Bounded task workers: spawn, steer, wait on, cancel and inspect.',
  actions: [
    {
      name: 'spawn',
      summary: 'Start a bounded worker whose grant is the intersection with this turn; no recursion.',
      access: 'write',
      privacy: 'conversation_scoped',
      admission: 'public',
      restrictions: ['grant_narrowing', 'idempotent'],
      workers: 'denied',
      inference: 'may_call_model',
      donor: { kind: 'donor', paths: [SUBAGENT_TOOL, 'src/faculties/subagents/capability-access.ts'] },
    },
    workerControl('message', 'Send guidance to a visible running worker.'),
    workerRead('wait', 'Wait for a visible worker to settle.'),
    workerControl('cancel', 'Cancel a visible worker.'),
    workerRead('status', 'Status of visible workers; unknown and withheld ids read alike.'),
    workerRead('discover', 'Durable run history visible to this audience.'),
    workerRead('inspect', 'Lineage, outcome and accounting of one visible run.'),
  ],
});
