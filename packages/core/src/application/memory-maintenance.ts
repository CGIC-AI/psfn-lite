import { ARC_WINDOW_MS, type EpisodeStorePort } from '../episodes/index.ts';
import type { MemoryStorePort } from '../memory/index.ts';
import type { SessionCatalogPort } from '../sessions/index.ts';
import { conversationKey, invalid, ok, type Clock, type CoreError, type Result, type SessionId } from '../shared/index.ts';
import type { ArcReport, ConsolidationReport, EpisodeFormation, FormationReport } from './episode-formation.ts';
import type { ExtractionReport, MemoryExtraction } from './memory-extraction.ts';
import { addUsage, embedTexts, emptyUsage, requireMaintenanceScope, type Embeddings, type InferenceUsage } from './memory-scope.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

const BACKFILL_BATCH = 32;

export interface BackfillReport {
  readonly memories: number;
  readonly episodes: number;
  /** Set when the embedding call failed; the items stay pending for the next run. */
  readonly failure: CoreError | null;
  readonly usage: InferenceUsage;
}

/** Embeds current memories and episodes that have no vector in the configured space yet. */
export function createEmbeddingBackfill(deps: {
  readonly memories: MemoryStorePort;
  readonly episodes: EpisodeStorePort;
  readonly embeddings: Embeddings;
}) {
  return {
    async run(limit: number): Promise<Result<BackfillReport>> {
      const usage = emptyUsage();
      const { space } = deps.embeddings;
      let memories = 0;
      let episodes = 0;
      const pendingMemories = await deps.memories.pendingEmbeddings(space, Math.min(limit, BACKFILL_BATCH));
      if (!pendingMemories.ok) return pendingMemories;
      const pendingEpisodes = await deps.episodes.pendingEmbeddings(space, Math.min(limit, BACKFILL_BATCH));
      if (!pendingEpisodes.ok) return pendingEpisodes;
      const texts = [
        ...pendingMemories.value.map((m) => m.content),
        ...pendingEpisodes.value.map((e) => episodeEmbeddingText(e.machineSignals.summary, e.meaning?.text ?? null)),
      ];
      if (texts.length === 0) return ok({ memories, episodes, failure: null, usage });
      const vectors = await embedTexts(deps.embeddings, texts, 'embedding_backfill');
      usage.embeddingCalls += 1;
      usage.embeddedTexts += texts.length;
      if (!vectors.ok) return ok({ memories, episodes, failure: vectors.error, usage });
      for (const [index, memory] of pendingMemories.value.entries()) {
        const put = await deps.memories.putEmbedding(memory.id, space, vectors.value[index] as readonly number[]);
        if (!put.ok) return put;
        memories += 1;
      }
      for (const [index, episode] of pendingEpisodes.value.entries()) {
        const put = await deps.episodes.putEmbedding(episode.id, space, vectors.value[pendingMemories.value.length + index] as readonly number[]);
        if (!put.ok) return put;
        episodes += 1;
      }
      return ok({ memories, episodes, failure: null, usage });
    },
  };
}

/** What an episode's vector represents: its runtime summary and, when present, the companion's meaning. */
export function episodeEmbeddingText(summary: string, meaning: string | null): string {
  return meaning === null ? summary : `${summary}\n${meaning}`;
}

export type EmbeddingBackfill = ReturnType<typeof createEmbeddingBackfill>;

export interface MaintenanceReport {
  readonly extraction: readonly ExtractionReport[];
  readonly formation: readonly FormationReport[];
  readonly consolidation: readonly ConsolidationReport[];
  readonly arcs: ArcReport | null;
  readonly backfill: BackfillReport | null;
  /** Each failed step with its error; later steps and other sessions still ran. */
  readonly failures: readonly { readonly step: string; readonly subject: string; readonly error: CoreError }[];
  readonly usage: InferenceUsage;
}

export interface MemoryMaintenance {
  run(scope: TrustedTurnScope, input: { readonly sessionLimit: number; readonly maxEntries: number }): Promise<Result<MaintenanceReport>>;
}

/**
 * The ordered nightly memory pass, recomposed from the donor's sleeptime
 * agent (`src/faculties/memory/sleeptime-agent.ts`) without its wiki pass,
 * which Lite excludes: extraction and episode formation per recent session,
 * then consolidation per touched conversation, arc weaving and the embedding
 * backfill. It runs only in a companion-internal turn. A step that fails is
 * reported with its error and never treated as done; its watermark stays put,
 * so the next run retries it.
 */
export function createMemoryMaintenance(deps: {
  readonly catalog: SessionCatalogPort;
  readonly extraction: MemoryExtraction;
  readonly formation: EpisodeFormation;
  readonly backfill: EmbeddingBackfill;
  readonly clock: Clock;
}): MemoryMaintenance {
  return {
    async run(scope, input) {
      const allowed = requireMaintenanceScope(scope);
      if (!allowed.ok) return allowed;
      if (!Number.isInteger(input.sessionLimit) || input.sessionLimit < 1 || input.sessionLimit > 500) return invalid('sessionLimit must be 1-500');
      const sessions = await deps.catalog.list(input.sessionLimit, null);
      if (!sessions.ok) return sessions;
      const usage = emptyUsage();
      const failures: { step: string; subject: string; error: CoreError }[] = [];
      const extraction: ExtractionReport[] = [];
      const formation: FormationReport[] = [];
      const conversations = new Set<string>();
      const step = <T extends object>(name: string, subject: string, result: Result<T>, into?: T[]): void => {
        if (!result.ok) {
          failures.push({ step: name, subject, error: result.error });
          return;
        }
        if ('usage' in result.value) addUsage(usage, result.value.usage as InferenceUsage);
        into?.push(result.value);
      };
      for (const session of sessions.value) {
        const sessionId: SessionId = session.sessionId;
        step('extraction', sessionId, await deps.extraction.extract(scope, { sessionId, maxEntries: input.maxEntries }), extraction);
        const formed = await deps.formation.form(scope, { sessionId, maxEntries: input.maxEntries });
        step('episode_formation', sessionId, formed, formation);
        // Every recent conversation is consolidated, so candidates left by an earlier failed run are retried.
        if (formed.ok) conversations.add(conversationKey(session.audience));
      }
      const consolidation: ConsolidationReport[] = [];
      for (const conversation of conversations) {
        step('consolidation', conversation, await deps.formation.consolidate(scope, { conversation }), consolidation);
      }
      const since = new Date(deps.clock.now().getTime() - ARC_WINDOW_MS).toISOString();
      const arcs = await deps.formation.weaveArcs(scope, { since });
      step('arcs', since, arcs);
      const backfill = await deps.backfill.run(BACKFILL_BATCH);
      step('embedding_backfill', 'all', backfill);
      if (backfill.ok && backfill.value.failure !== null) failures.push({ step: 'embedding_backfill', subject: 'all', error: backfill.value.failure });
      return ok({
        extraction,
        formation,
        consolidation,
        arcs: arcs.ok ? arcs.value : null,
        backfill: backfill.ok ? backfill.value : null,
        failures,
        usage,
      });
    },
  };
}
