/**
 * Memory, episode and journal tables in the structured-state backup, in
 * foreign-key order. Embeddings are backed up as rows like any other state;
 * the per-space HNSW indexes are rebuilt when the stores open.
 */
export const MEMORY_BACKED_UP_TABLES = Object.freeze([
  { name: 'memories', orderBy: 'seq', identity: 'seq' },
  { name: 'memory_write_receipts', orderBy: 'idempotency_key' },
  { name: 'memory_links', orderBy: 'seq', identity: 'seq' },
  { name: 'memory_events', orderBy: 'seq', identity: 'seq' },
  { name: 'memory_embeddings', orderBy: 'memory_id, space' },
  { name: 'memory_deletion_proposals', orderBy: 'seq', identity: 'seq' },
  { name: 'scratchpad_notes', orderBy: 'seq', identity: 'seq' },
  { name: 'session_cursors', orderBy: 'purpose, session_id' },
  { name: 'episodes', orderBy: 'seq', identity: 'seq' },
  { name: 'episode_meanings', orderBy: 'episode_id, revision' },
  { name: 'episode_embeddings', orderBy: 'episode_id, space' },
  { name: 'episode_arcs', orderBy: 'arc_id' },
  { name: 'episode_arc_members', orderBy: 'arc_id, episode_id' },
  { name: 'journal_notes', orderBy: 'path' },
  { name: 'reflections', orderBy: 'seq', identity: 'seq' },
  { name: 'letters', orderBy: 'seq', identity: 'seq' },
  { name: 'letter_events', orderBy: 'seq', identity: 'seq' },
] as const);
