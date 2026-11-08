import { defineTool, type ActionDescriptor } from '../shared/index.ts';

const JOURNAL_TOOL = 'src/boundary/integrations/journal/tools.ts';
const JOURNAL_PROVENANCE = 'src/boundary/integrations/journal/provenance.ts';
const LETTER_TOOL = 'src/core/tools/letter.ts';
const LETTER_SERVICE = 'src/core/letters/service.ts';

function journalAction(name: string, summary: string, access: 'read' | 'write'): ActionDescriptor {
  return {
    name,
    summary,
    access,
    privacy: 'conversation_scoped',
    admission: 'public',
    restrictions: access === 'read' ? ['visibility_gated'] : ['companion_authored', 'visibility_gated'],
    workers: access === 'read' ? 'allowed' : 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [JOURNAL_TOOL, JOURNAL_PROVENANCE] },
  };
}

function letterAction(
  name: string,
  summary: string,
  access: 'read' | 'write',
  restrictions: ActionDescriptor['restrictions'],
): ActionDescriptor {
  return {
    name,
    summary,
    access,
    privacy: 'companion_private',
    admission: 'confidential',
    restrictions,
    workers: 'denied',
    inference: 'none',
    donor: { kind: 'donor', paths: [LETTER_TOOL, LETTER_SERVICE] },
  };
}

function reflectionRead(name: string, summary: string): ActionDescriptor {
  return {
    name,
    summary,
    access: 'read',
    privacy: 'companion_private',
    admission: 'confidential',
    restrictions: [],
    workers: 'denied',
    inference: 'none',
    donor: {
      kind: 'lite_new',
      rationale: 'Donor reflection JSONL journals had no model-facing reader; Lite needs complete journal access.',
      related: ['src/persistence/journals/reflection-journal.ts', 'src/persistence/journals/reflection-substrate.ts'],
    },
  };
}

export const journalTool = defineTool({
  name: 'journal',
  domain: 'journals',
  summary: 'Companion-authored workspace journal, reflection records and private letters.',
  actions: [
    journalAction('list', 'Journal notes readable here.', 'read'),
    journalAction('read', 'One readable note; unreadable reads as missing.', 'read'),
    journalAction('search', 'Search readable notes.', 'read'),
    journalAction('write', 'Create or overwrite a readable note with runtime-stamped provenance.', 'write'),
    journalAction('append', 'Append to a readable note; merging sources makes it restricted.', 'write'),
    reflectionRead('reflections_list', 'Recent reflection records with their authorship.'),
    reflectionRead('reflections_read', 'One reflection record.'),
    letterAction('letter_compose', 'Compose a letter to the Partner; idempotent by id.', 'write', [
      'companion_authored',
      'idempotent',
      'append_only',
    ]),
    letterAction('letter_list', 'Letters in the bin.', 'read', []),
    letterAction('letter_read', 'Read a letter; reading is recorded as lived history.', 'read', []),
    letterAction('letter_place', 'Place a drafted letter for the Partner.', 'write', ['companion_authored', 'append_only']),
    letterAction('letter_archive', 'Archive a letter.', 'write', ['companion_authored', 'append_only']),
  ],
});
