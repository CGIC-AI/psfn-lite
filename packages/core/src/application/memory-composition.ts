import type { ContactStorePort } from '../contacts/index.ts';
import type { EpisodeStorePort } from '../episodes/index.ts';
import type { JournalNotePort, LetterPort, ReflectionPort } from '../journals/index.ts';
import type { MemoryDeletionPort, MemoryStorePort, ScratchpadPort, SessionCursorPort } from '../memory/index.ts';
import type { SessionArchivePort, SessionCatalogPort } from '../sessions/index.ts';
import { ok, type Clock, type IdSource, type Result } from '../shared/index.ts';
import type { ActionHandlers } from './dispatch.ts';
import { createEpisodeFormation } from './episode-formation.ts';
import { createEpisodeService } from './episode-service.ts';
import { createMemoryHandlers } from './handlers-memory.ts';
import type { ApprovalPort, EmbeddingPort, ModelPort } from './host-ports.ts';
import { createJournalService } from './journal-service.ts';
import { createLetterAdministration, createLetterService } from './letter-service.ts';
import { createMemoryAdministration } from './memory-administration.ts';
import { createMemoryExtraction } from './memory-extraction.ts';
import { createEmbeddingBackfill, createMemoryMaintenance } from './memory-maintenance.ts';
import { validateSpace } from './memory-scope.ts';
import { createMemoryService } from './memory-service.ts';
import { createMemoryWriter } from './memory-writer.ts';
import { createScratchpadService } from './scratchpad-service.ts';

/** The ports the memory, episode and journal stack needs. Each service still takes only its own subset. */
export interface MemoryStackDeps {
  readonly memories: MemoryStorePort;
  readonly deletions: MemoryDeletionPort;
  readonly scratchpad: ScratchpadPort;
  readonly extractionCursors: SessionCursorPort;
  readonly episodes: EpisodeStorePort;
  readonly formationCursors: SessionCursorPort;
  readonly journal: JournalNotePort;
  readonly reflections: ReflectionPort;
  readonly letters: LetterPort;
  readonly contacts: ContactStorePort;
  readonly catalog: SessionCatalogPort;
  readonly archive: SessionArchivePort;
  readonly approvals: ApprovalPort;
  readonly model: ModelPort;
  readonly embedding: { readonly port: EmbeddingPort; readonly space: { readonly name: string; readonly dimensions: number } };
  readonly clock: Clock;
  readonly ids: IdSource;
  /** Idle time after which a conversation counts as ended for episode formation. */
  readonly endedAfterMs: number;
}

/**
 * Composes the memory, episode and journal stack: the model-facing handlers
 * for the `memory`, `episode` and `journal` tools, the maintenance pass and
 * the operator administration. There is no in-memory fallback for any port
 * and no wiki dependency.
 */
export function createMemoryStack(deps: MemoryStackDeps): Result<{
  readonly handlers: ActionHandlers;
  readonly maintenance: ReturnType<typeof createMemoryMaintenance>;
  readonly administration: ReturnType<typeof createMemoryAdministration>;
  readonly letterAdministration: ReturnType<typeof createLetterAdministration>;
  readonly journal: ReturnType<typeof createJournalService>;
}> {
  const space = validateSpace(deps.embedding.space);
  if (!space.ok) return space;
  const embeddings = { port: deps.embedding.port, space: space.value };
  const { clock, ids } = deps;
  const writer = createMemoryWriter({ store: deps.memories, embeddings, clock, ids });
  const formation = createEpisodeFormation({
    catalog: deps.catalog,
    archive: deps.archive,
    cursors: deps.formationCursors,
    episodes: deps.episodes,
    model: deps.model,
    clock,
    endedAfterMs: deps.endedAfterMs,
  });
  if (!formation.ok) return formation;
  const journal = createJournalService({ notes: deps.journal, reflections: deps.reflections, clock });
  const handlers = createMemoryHandlers({
    memory: createMemoryService({
      store: deps.memories,
      deletions: deps.deletions,
      writer,
      embeddings,
      episodes: deps.episodes,
      contacts: deps.contacts,
      catalog: deps.catalog,
      approvals: deps.approvals,
      clock,
      ids,
    }),
    scratchpad: createScratchpadService({ store: deps.scratchpad, clock, ids }),
    episodes: createEpisodeService({ store: deps.episodes, embeddings, clock }),
    journal,
    letters: createLetterService({ letters: deps.letters, clock }),
  });
  const extraction = createMemoryExtraction({
    catalog: deps.catalog,
    archive: deps.archive,
    cursors: deps.extractionCursors,
    writer,
    model: deps.model,
    contacts: deps.contacts,
  });
  const backfill = createEmbeddingBackfill({ memories: deps.memories, episodes: deps.episodes, embeddings });
  return ok({
    handlers,
    maintenance: createMemoryMaintenance({ catalog: deps.catalog, extraction, formation: formation.value, backfill, clock }),
    administration: createMemoryAdministration({ store: deps.memories, deletions: deps.deletions, clock }),
    letterAdministration: createLetterAdministration({ letters: deps.letters, clock }),
    journal,
  });
}
