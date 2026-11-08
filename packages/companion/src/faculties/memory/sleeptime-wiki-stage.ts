// ── Sleeptime wiki stage (no-op) ──
//
// Lite extraction (seam 3.17, wiki cut: the wiki is not part of the core).
// The sleeptime agent keeps its ordered stages, wiki_pass included, and
// requires a runner for every stage (sleeptime-agent.ts constructor). Lite's
// runner is the donor's own disabled path: SleeptimeWikiPass.run returns the
// empty result with skippedReason 'disabled' before reading anything when
// `sleeptime.wikiPass.enabled` is false (donor sleeptime-wiki-pass.ts:506-521).
// The sleeptime agent ignores the result (sleeptime-agent.ts, case 'wiki_pass').
//
// Declarations copied verbatim from the donor at e6a9546:
// src/faculties/wiki/sleeptime-wiki-pass.ts:146-189 (run input, skip reason,
// run result). The runner body is :507-520 with `this.config.enabled` false.

export interface SleeptimeWikiPassRunInput {
  sessionId: string;
  sourceMessageId?: string;
  throughRevision?: number;
  throughOccurredAtMs?: number;
}

/**
 * `nothing_durable` (psfn-framework-lpxg3.3): the pass ran a full proposal
 * cycle and nothing survived as durable world knowledge — every proposal was
 * a personal-boundary rejection, a byte-identical no-op, or absent entirely.
 * That is a real, recordable outcome, distinct from "the gate never opened",
 * and it advances the watermark like any other completed review.
 */
export type WikiPassSkipReason =
  | 'disabled'
  | 'no_material'
  | 'malformed_output'
  | 'nothing_durable';

export interface SleeptimeWikiPassRunResult {
  ran: boolean;
  skippedReason?: WikiPassSkipReason;
  reviewedEpisodes: number;
  reviewedMemories: number;
  entriesCreated: number;
  entriesUpdated: number;
  proposalsRejected: number;
  /**
   * Generated syntheses that were written but held by CogSec admission
   * (psfn-framework-1fjvm.2). They are durable on disk for the operator to
   * review and are not retrievable; the rest of the run's entries continue
   * normally, so one hostile synthesis never stops the pass.
   */
  entriesHeld: number;
  /**
   * Proposals whose exact content already existed on the target entry. They
   * reuse the existing admitted version: no new version, no history entry, no
   * repeated notice (psfn-framework-lpxg3.3 AC6).
   */
  entriesUnchanged: number;
  /** Proposals folded into an existing near-duplicate entry instead of creating one. */
  nearDuplicatesFolded: number;
}

/** The stage contract the sleeptime agent and the reflection runtime hold. */
export interface SleeptimeWikiPass {
  run(input: SleeptimeWikiPassRunInput): Promise<SleeptimeWikiPassRunResult>;
}

/** The wiki_pass stage with the wiki cut: the donor's disabled-pass result. */
export function createDisabledSleeptimeWikiPass(): SleeptimeWikiPass {
  return {
    async run(_input: SleeptimeWikiPassRunInput): Promise<SleeptimeWikiPassRunResult> {
      const empty: SleeptimeWikiPassRunResult = {
        ran: false,
        reviewedEpisodes: 0,
        reviewedMemories: 0,
        entriesCreated: 0,
        entriesUpdated: 0,
        proposalsRejected: 0,
        entriesHeld: 0,
        entriesUnchanged: 0,
        nearDuplicatesFolded: 0,
      };
      return { ...empty, skippedReason: 'disabled' };
    },
  };
}
