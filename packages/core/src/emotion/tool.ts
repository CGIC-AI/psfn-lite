import { defineTool } from '../shared/index.ts';

export const emotionTool = defineTool({
  name: 'emotion',
  domain: 'emotion',
  summary: 'Inspect scoped affect estimates and record companion-authored self-reports.',
  actions: [
    {
      name: 'read',
      summary: 'The machine estimate for the current audience scope only, labelled as inference.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['current_scope_only'],
      workers: 'denied',
      inference: 'none',
      donor: {
        kind: 'lite_new',
        rationale: 'Donor exposed emotion only through prompt variables; Lite adds a governed scoped reader.',
        related: ['src/core/emotion/state.ts', 'src/core/emotion/scoped-emotion.ts', 'src/core/emotion/persona-adaptation.ts'],
      },
    },
    {
      name: 'appraisals',
      summary: 'Recent narrative appraisals, attributed as machine inference.',
      access: 'read',
      privacy: 'companion_private',
      admission: 'confidential',
      restrictions: [],
      workers: 'denied',
      inference: 'none',
      donor: {
        kind: 'lite_new',
        rationale: 'Donor kept the appraisal chain internal; charter 11 requires inspection.',
        related: ['src/core/emotion/appraisal.ts', 'src/core/emotion/appraisal-state.ts'],
      },
    },
    {
      name: 'self_report',
      summary: 'Record how the companion describes its own state, distinct from estimates.',
      access: 'write',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['companion_authored', 'current_scope_only', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: {
        kind: 'lite_new',
        rationale: 'Donor had no companion-authored affect record; estimates must not stand in for one.',
        related: ['src/core/emotion/state.ts'],
      },
    },
  ],
});
