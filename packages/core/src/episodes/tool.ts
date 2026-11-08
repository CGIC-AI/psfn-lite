import { defineTool } from '../shared/index.ts';

const EPISODIC_RETRIEVAL = 'src/faculties/memory/retrieval/episodic.ts';

export const episodeTool = defineTool({
  name: 'episode',
  domain: 'episodes',
  summary: 'Lived episodes and arcs; machine drafts stay distinct from companion-authored meaning.',
  actions: [
    {
      name: 'search',
      summary: 'Hybrid search over visible episodes, reporting lexical/semantic health.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: {
        kind: 'donor',
        paths: ['src/faculties/memory/tools.ts', 'src/faculties/memory/retrieval/episode-search.ts', EPISODIC_RETRIEVAL],
      },
    },
    {
      name: 'get',
      summary: 'One visible episode with source turns and arc siblings whose members are all visible.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: ['src/faculties/memory/retrieval/episode-drilldown.ts', EPISODIC_RETRIEVAL] },
    },
    {
      name: 'timeline',
      summary: 'Visible episodes in a date range; unreviewed ones are labelled machine-drafted.',
      access: 'read',
      privacy: 'audience_scoped',
      admission: 'public',
      restrictions: ['visibility_gated'],
      workers: 'allowed',
      inference: 'none',
      donor: { kind: 'donor', paths: ['src/faculties/memory/tools.ts', EPISODIC_RETRIEVAL] },
    },
    {
      name: 'author_meaning',
      summary: 'The companion writes or revises its own meaning for an episode during a self turn.',
      access: 'write',
      privacy: 'companion_private',
      admission: 'confidential',
      restrictions: ['companion_authored', 'self_audience_only', 'append_only'],
      workers: 'denied',
      inference: 'none',
      donor: {
        kind: 'lite_new',
        rationale: 'Donor had no model-facing meaning writer; meaning was authored only inside the dream pass.',
        related: ['src/faculties/memory/episodic/dream-meaning-pass.ts', 'src/faculties/memory/episodic/store-port.ts'],
      },
    },
  ],
});
