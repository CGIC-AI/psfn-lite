import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const CORE_MEMORY_TOOL = 'src/faculties/core-memory/tools.ts';
const PROMPT_TOOL = 'src/core/identity/prompt-tools.ts';
const VALUES_TOOL = 'src/faculties/values/tools.ts';
const NORTH_STAR_TOOL = 'src/faculties/north-star/tools.ts';

function blockWrite(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: ['companion_authored', 'current_scope_only', 'foreground_only'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [CORE_MEMORY_TOOL, 'src/faculties/core-memory/store.ts'] },
  };
}

function layerRead(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'read',
    privacy: 'identity_by_design',
    admission: 'public',
    restrictions: [],
    workers: 'allowed',
    inference: 'none',
    donor: { kind: 'donor', paths: [PROMPT_TOOL] },
  };
}

function layerWrite(name: string, summary: string, paths: readonly string[] = [PROMPT_TOOL]): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'identity_by_design',
    admission: 'public',
    restrictions: ['companion_authored', 'append_only', 'approval_for_protected'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths },
  };
}

export const orientTool = defineTool({
  name: 'orient',
  domain: 'identity',
  summary: 'Orientation blocks for this conversation, prompt layers and persona.',
  actions: [
    {
      name: 'view',
      summary: 'Orientation blocks of the current conversation scope.',
      access: 'read',
      privacy: 'conversation_scoped',
      admission: 'public',
      restrictions: ['current_scope_only'],
      workers: 'allowed',
      inference: 'none',
      donor: {
        kind: 'lite_new',
        rationale: 'Donor only rendered blocks into the prompt; charter 11 requires a governed reader.',
        related: ['src/faculties/core-memory/store.ts'],
      },
    },
    blockWrite('append', 'Append to a block of the current conversation scope.'),
    blockWrite('replace', 'Replace text within a block of the current conversation scope.'),
    blockWrite('reorient', 'Rewrite all three blocks of the current conversation scope together.'),
    layerRead('list_layers', 'Prompt layers in precedence order.'),
    layerRead('get_layer', 'One prompt layer.'),
    layerRead('diff_layer', 'Difference between a layer version and its predecessor.'),
    layerRead('layer_history', 'Append-only history of a layer.'),
    layerWrite('update_layer', 'Runtime/channel/task layers write directly; base/operator layers queue for approval.'),
    layerWrite('rollback_layer', 'Roll back by appending a new version; protected layers queue for approval.'),
    layerWrite('toggle_layer', 'Enable or disable a layer; protected layers queue for approval.'),
    layerWrite('update_persona', 'Patch persona card fields; protected fields queue for approval.', [
      PROMPT_TOOL,
      'src/core/identity/card-versioning.ts',
    ]),
  ],
});

function northStarWrite(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'write',
    privacy: 'identity_by_design',
    admission: 'public',
    restrictions: ['companion_authored', 'append_only', 'foreground_only'],
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [NORTH_STAR_TOOL, 'src/faculties/north-star/store.ts'] },
  };
}

export const valuesTool = defineTool({
  name: 'values',
  domain: 'identity',
  summary: 'Companion-authored values journal and the North Star, distinct from the constitution.',
  actions: [
    {
      name: 'list_values',
      summary: 'Recent companion-authored values.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'personal',
      restrictions: [],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: [VALUES_TOOL, CORE_MEMORY_TOOL] },
    },
    {
      name: 'add_value',
      summary: 'Append a companion-authored value.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'personal',
      restrictions: ['companion_authored', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [VALUES_TOOL, 'src/faculties/values/store.ts'] },
    },
    {
      name: 'revise_value',
      summary: 'Append a new version derived from an existing value.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'personal',
      restrictions: ['companion_authored', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: { kind: 'donor', paths: [VALUES_TOOL] },
    },
    {
      name: 'north_star_list',
      summary: 'Ordered North Star items.',
      access: 'read',
      privacy: 'identity_by_design',
      admission: 'public',
      restrictions: [],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: [NORTH_STAR_TOOL] },
    },
    northStarWrite('north_star_create', 'Add an item; at most three exist.'),
    northStarWrite('north_star_update', 'Revise an item as a new version.'),
    northStarWrite('north_star_reorder', 'Reorder every item exactly once.'),
    northStarWrite('north_star_retire', 'Retire an item; history is kept (donor delete was hard).'),
  ],
});
