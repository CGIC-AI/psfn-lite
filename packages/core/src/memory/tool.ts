import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const MEMORY_TOOL = 'src/faculties/memory/tools.ts';
const VISIBILITY = 'src/faculties/memory/tools/visibility.ts';
const SCRATCHPAD_TOOL = 'src/faculties/memory/tools/scratchpad.ts';
const SCRATCHPAD_VISIBILITY = 'src/faculties/memory/scratchpad-visibility.ts';
const WORKER_GOVERNANCE = 'src/faculties/subagents/memory-governance.ts';

function memoryRead(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'read',
    privacy: 'audience_scoped',
    admission: 'public',
    restrictions: ['visibility_gated'],
    workers: 'allowed',
    inference: 'none',
    donor: { kind: 'donor', paths: [MEMORY_TOOL, VISIBILITY] },
  };
}

function scratchpad(name: string, summary: string, access: 'read' | 'write'): ActionDescriptor {
  return {
    name,
    summary,
    access,
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: access === 'read' ? ['current_scope_only'] : ['companion_authored', 'current_scope_only'],
    workers: 'allowed',
    inference: 'none',
    donor: { kind: 'donor', paths: [SCRATCHPAD_TOOL, SCRATCHPAD_VISIBILITY] },
  };
}

export const memoryTool = defineTool({
  name: 'memory',
  domain: 'memory',
  summary: 'Durable typed memory and same-day scratchpad notes, filtered by audience.',
  actions: [
    memoryRead('search', 'Text search over visible current memories.'),
    memoryRead('get', 'One visible memory with provenance.'),
    memoryRead('shared_background', 'Visible overlap between the companion and a visible contact.'),
    memoryRead('census', 'Counts of visible memories by kind; counts are themselves audience-filtered.'),
    {
      name: 'write',
      summary: 'Write a memory; restricted kinds written by workers are staged for review.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'idempotent'],
      workers: 'review_staged',
      inference: 'may_call_model',
      donor: { kind: 'donor', paths: [MEMORY_TOOL, 'src/faculties/memory/writer.ts', WORKER_GOVERNANCE] },
    },
    {
      name: 'import',
      summary: 'Batch import with validated occurrence times; any restricted record stages the whole batch for workers.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'idempotent'],
      workers: 'review_staged',
      inference: 'may_call_model',
      donor: { kind: 'donor', paths: [MEMORY_TOOL, WORKER_GOVERNANCE] },
    },
    {
      name: 'patch',
      summary: 'Correct a visible memory with a reason; recorded as a patch event.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'visibility_gated', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [MEMORY_TOOL] },
    },
    {
      name: 'propose_delete',
      summary: 'Propose a reversible soft delete; only an authenticated operator approval applies it.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated', 'proposal_only'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [MEMORY_TOOL, 'src/faculties/memory/deletion-proposals.ts'] },
    },
    {
      name: 'restore',
      summary: 'Undo an applied soft delete of a visible memory.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'visibility_gated', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [MEMORY_TOOL] },
    },
    scratchpad('scratchpad_list', 'Notes visible in this conversation plus companion-global notes.', 'read'),
    scratchpad('scratchpad_add', 'Add a same-day note to this conversation (global only when explicit).', 'write'),
    scratchpad('scratchpad_replace', 'Replace a note visible in this conversation.', 'write'),
    scratchpad('scratchpad_append', 'Append to a note visible in this conversation.', 'write'),
    scratchpad('scratchpad_remove', 'Remove a note visible in this conversation.', 'write'),
  ],
});
