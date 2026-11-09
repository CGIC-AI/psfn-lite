// ── Skills runtime port (empty runtime) ──
//
// Lite extraction (seam 3.17, skills cut; operator ruling: skills is an empty
// runtime). The agent keeps the donor's optional `skillsRuntime` slot, which
// is null by default (donor substrate-agent.ts:615, "null until skills system
// is wired"). With it null, as in Lite, the prompt's skills index is empty and
// the turn runtime skips the reflection-nudge step (turn-execution-runtime.ts,
// `if (runtime.skillsRuntime)`), exactly as in the donor. The port keeps only
// the two prompt reads the core makes; the skill index, admission, reuse
// ranking and the reflection nudge itself are the skills faculty and are cut.
//
// Copied verbatim from the donor at e6a9546:
// - TurnToolSummary: src/faculties/skills/reflection-nudge.ts:45-60;
// - the SkillsRuntime method signatures: src/faculties/skills/runtime.ts:156,160
//   (the donor class's getPromptXml and getCachedPromptXml).

import type { ToolCallOutcomeCounts } from './tool-call-outcome.js';

export interface TurnToolSummary {
  toolCalls: number;
  usedThinkTool: boolean;
  /**
   * Bounded task cue — the participant's framing for this turn. Absent means
   * "no cue", which yields no candidates and therefore only ever a create
   * opportunity.
   */
  taskCue?: string;
  /**
   * Structural, content-free census of what the turn's tool calls returned
   * (psfn-framework-lpxg3.2). Absent means the outcome is unknown, and an
   * unknown outcome is not evidence of success.
   */
  outcomes?: ToolCallOutcomeCounts;
}

/** The skills runtime reads the core makes; null when no skills runtime is wired. */
export interface SkillsRuntime {
  getPromptXml(): Promise<string>;
  getCachedPromptXml(): string;
}
