import { defineTool } from '../shared/index.ts';

const RATIONALE = 'Donor had no unified activity record; recent work was scattered across worker status, sessions and free time.';
const RELATED = [
  'src/faculties/subagents/tools.ts',
  'src/core/session/continuity-artifacts.ts',
  'src/core/scheduler/free-time-activity.ts',
] as const;

export const activityTool = defineTool({
  name: 'activity',
  domain: 'activity',
  summary: 'What the companion has been doing: purpose, status, outcome, artifacts and reflection.',
  actions: [
    {
      name: 'recent',
      summary: 'Recent activities visible to this audience.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'lite_new', rationale: RATIONALE, related: RELATED },
    },
    {
      name: 'get',
      summary: 'One visible activity; invisible reads as missing.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'lite_new', rationale: RATIONALE, related: RELATED },
    },
    {
      name: 'start',
      summary: 'Begin an activity bound to the current turn and audience.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'current_scope_only'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'lite_new', rationale: RATIONALE, related: RELATED },
    },
    {
      name: 'update',
      summary: 'Settle status/outcome, attach artifacts or add an attributed reflection.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'visibility_gated', 'append_only'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'lite_new', rationale: RATIONALE, related: RELATED },
    },
  ],
});
