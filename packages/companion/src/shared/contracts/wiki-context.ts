// ── Wiki context snapshot (type contract) ──
//
// Lite extraction (seam 3.17, wiki cut: the wiki is not part of the core). The
// turn keeps the donor's optional wiki retrieval port (`WikiRetrievalPort` in
// core/agent/contracts.ts, `runtime.wikiRetrieval` in pre-turn-state.ts); with
// no port wired the wiki block is empty, exactly as in the donor. A host that
// supplies a wiki implements the port with this snapshot shape.
//
// Declarations copied verbatim from the donor at e6a9546:
// src/faculties/wiki/active-context.ts:4-39.

import type { DisclosureWikiSource } from '../../core/cogsec/disclosure/generation-lineage.js';

export type WikiRetrievalContextClass = 'dm' | 'group' | 'focus';

/**
 * mmo9.7.4: the wiki context cache mirrors active-memory's refresh lifecycle
 * (`faculties/memory/active-context.ts`). A turn reads the last-good snapshot
 * synchronously and schedules an off-path refresh; the status makes the
 * degraded/in-flight state explicit rather than silent.
 */
export type WikiRefreshStatus = 'ready' | 'refreshing' | 'degraded';

/**
 * Cached wiki context for one keyed lane (`channelId` + contextClass + scope).
 * `contextClass: null` is the deterministic-gate skip (disabled, or a zero cap
 * for the turn's class): a `ready`, empty, non-degraded snapshot — never a
 * cold miss.
 */
export interface WikiContextSnapshot {
  key: string;
  channelId: string;
  contextClass: WikiRetrievalContextClass | null;
  block: string;
  tokenCount: number;
  selectedCount: number;
  /**
   * jp36.1.1.3: content-free outbound-disclosure facts (ref + sensitivity) for
   * every wiki document rendered into this block, folded into the generation
   * disclosure lineage at the turn seam (bible §9.2 item 3). Wiki world-knowledge
   * authorizes no outward destination, so each source collapses to companion-self.
   */
  disclosureWikiSources?: DisclosureWikiSource[];
  generatedAt: number;
  lastRefreshStartedAt: number;
  lastRefreshCompletedAt?: number;
  refreshStatus: WikiRefreshStatus;
  lastRefreshError?: string;
}
