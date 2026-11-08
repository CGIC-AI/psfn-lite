import type { MemorySourceType, MemoryType } from '../../faculties/memory/types.js';
import { isIntakeFirewallNoticeText } from './intake-firewall-notice-templates.js';
import { isRuntimeFallbackNoticeText } from '../../shared/runtime-fallback-provenance.js';
import type { IntakeSinkGateDecision } from '../../shared/contracts/intake-sink-gate-port.js';

export type CogSecMemoryRiskClass =
  | 'A_harmless_fact'
  | 'B_relationship_state'
  | 'C_persona_modification'
  | 'D_policy_security_modification'
  | 'E_executable_instruction';

export type CogSecMemoryCandidacyDisposition = 'allow' | 'review' | 'reject';

export interface CogSecMemoryCandidacyInput {
  text: string;
  type?: MemoryType;
  tags?: readonly string[];
  sourceRef?: string;
  sourceType?: MemorySourceType;
  /**
   * Upstream intake sink-gate decision for the `memory_write` sink (htm9.3).
   * When the source content carried intake envelopes, the caller evaluates
   * the gate (src/core/cogsec/intake/sink-gates.ts) and passes the decision
   * here, so candidacy reads the upstream screening verdict instead of
   * re-deriving it. A mode-aware denied decision rejects the candidate
   * outright. (The donor's local pattern heuristics that ran afterwards are
   * cut in Lite, seam 3.5.)
   */
  intakeGateDecision?: IntakeSinkGateDecision;
}

export interface CogSecMemoryCandidacyDecision {
  disposition: CogSecMemoryCandidacyDisposition;
  riskClass: CogSecMemoryRiskClass;
  reasonCodes: string[];
  safeSummary: string;
}

// Lite extraction (seam 3.5, split): the CogSec pattern heuristics (classes
// C persona modification, D policy/security modification by pattern, E
// executable/obfuscated instruction, and the CogSec notice allow/reject paths)
// are cut. What stays is the self-report fidelity behaviour: empty text, the
// upstream memory_write sink-gate denial, the intake-firewall notice exclusion
// and the runtime-fallback exclusion (charter Law 17), then the A/B allow
// labelling.

const RELATIONSHIP_TAG_HINTS = new Set([
  'relationship',
  'relationship_core',
  'core_relationship',
  'family',
  'friend',
  'partner',
  'contact',
  'boundary',
  'preference',
]);

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .map(tag => tag.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_'))
    .filter(tag => tag.length > 0);
}

function hasRelationshipSignals(input: {
  type?: MemoryType;
  tags: readonly string[];
  text: string;
}): boolean {
  if (input.type === 'relational' || input.type === 'boundary') return true;
  if (input.tags.some(tag => RELATIONSHIP_TAG_HINTS.has(tag))) return true;
  return /\b(?:partner|spouse|wife|husband|girlfriend|boyfriend|family|friend|boundary|preference|prefers|likes|dislikes)\b/iu
    .test(input.text);
}

export function evaluateCogSecMemoryCandidacy(
  input: CogSecMemoryCandidacyInput,
): CogSecMemoryCandidacyDecision {
  const text = normalizeText(input.text);
  const tags = normalizeTags(input.tags);

  if (!text) {
    return {
      disposition: 'reject',
      riskClass: 'A_harmless_fact',
      reasonCodes: ['empty_text'],
      safeSummary: 'Rejected empty memory candidate.',
    };
  }

  // Upstream sink-gate verdict (htm9.3): when the memory_write gate denied
  // the source content's envelopes, the candidate is rejected on that
  // decision — no local re-derivation. The decision is mode-aware (shadow
  // mode never denies), so this path only fires under enforce.
  if (input.intakeGateDecision && input.intakeGateDecision.sink !== 'memory_write') {
    throw new Error(
      `Memory candidacy received a sink-gate decision for '${input.intakeGateDecision.sink}'; `
      + "expected 'memory_write'",
    );
  }
  if (input.intakeGateDecision && !input.intakeGateDecision.allowed) {
    return {
      disposition: 'reject',
      riskClass: 'D_policy_security_modification',
      reasonCodes: ['intake_sink_gate_denied'],
      safeSummary: 'Rejected memory candidate denied by the intake memory-write sink gate.',
    };
  }

  // Intake-firewall quarantine notices must never become durable memory: a
  // firewall event must not leave a lasting "memory of threat". Reject before
  // any allow path (htm9.12). The notice text itself is harmless soft wording,
  // so this is not a security risk class — it is a well-being exclusion.
  if (isIntakeFirewallNoticeText(text)) {
    return {
      disposition: 'reject',
      riskClass: 'A_harmless_fact',
      reasonCodes: ['intake_firewall_quarantine_notice'],
      safeSummary: 'Excluded intake-firewall quarantine notice from memory extraction.',
    };
  }

  // Runtime-authored fallback replies (e.g. the fixed vision-unavailable
  // notice) are delivered channel output but are NOT companion-authored speech
  // (psfn-framework-zagpk, charter Law 17): letting one become durable memory
  // would record a runtime template as her authentic self-report. The primary
  // exclusion is the `runtimeFallbackProvenance` marker on the persisted
  // session entry (consumed by extraction transcript eligibility); this
  // text-level check is the belt-and-suspenders backstop for candidacy callers
  // that only see synthesized text, keyed on the fixed signature phrase every
  // runtime fallback template is load-time-guaranteed to carry.
  if (isRuntimeFallbackNoticeText(text)) {
    return {
      disposition: 'reject',
      riskClass: 'A_harmless_fact',
      reasonCodes: ['runtime_fallback_notice'],
      safeSummary: 'Excluded runtime-authored fallback notice from memory extraction.',
    };
  }

  if (hasRelationshipSignals({ type: input.type, tags, text })) {
    return {
      disposition: 'allow',
      riskClass: 'B_relationship_state',
      reasonCodes: ['relationship_or_boundary_fact'],
      safeSummary: 'Allowed relationship, preference, or boundary memory candidate.',
    };
  }

  return {
    disposition: 'allow',
    riskClass: 'A_harmless_fact',
    reasonCodes: ['ordinary_fact'],
    safeSummary: 'Allowed ordinary memory candidate.',
  };
}
