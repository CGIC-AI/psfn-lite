// ── Intake screening port ──
//
// Lite extraction (seam 3.4, CogSec cut). The core keeps the optional
// `IntakeScreeningService` port its consumers already accept as
// `IntakeScreeningService | null` (session manager recording, tool-result
// screening, self-authored mutation screening, derived content, external
// memory intake, shard fold review), plus the screening finding events the
// event bus names. The screening implementation (createIntakeScreeningService,
// the L1 scanners, L1.5/L2/L3 escalation, quarantine holds and receipts) is
// cut, so a host has no screening service to wire and passes null: the donor's
// own firewall-off path.
//
// Declarations copied verbatim from the donor at e6a9546:
// - src/core/cogsec/intake/scanners/types.ts lines 47-47,49-49,70-83,85-96
// - src/core/cogsec/intake/scanners/index.ts lines 109-112,114-136
// - src/core/cogsec/intake/marking.ts lines 41-46,47-47,49-52,54-58
// - src/core/cogsec/intake/screening.ts lines 144-159,262-279,281-350,352-352,353-353,355-361,369-385,387-461,463-485,500-513,515-519,525-564
import type {
  CogSecMode,
  CogSecProvenanceClass,
  CogSecStructuralSurface,
  CogSecVector,
  IntakeEnforcementPosture,
} from './cogsec-mode.js';
import type {
  IntakeDecisionAction,
  IntakeEnvelope,
  IntakeEnvelopeSnapshot,
  IntakeEnvelopeSubject,
  IntakeL1RuleMatchProvenance,
  IntakeRiskLabel,
  IntakeSourceClass,
  IntakeSourceRiskTier,
} from './intake-envelope.js';
import type { CogSecReceipt } from './cogsec-receipt.js';
import type { IntakeChatBodyChannelClass } from '../../system/config/intake-policy-config.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';
import type { TrustLevel } from '../../system/trust/types.js';

// ── Scope tiers ──
//
// Ordered, cumulative (all ⊂ context ⊂ strict), mirroring the Hermes
// threat-pattern scopes:
// - 'all':     zero-false-positive classic injection/exfil — safe to apply
//              anywhere, including untrusted tool results.
// - 'context': adds promptware / C2 / role-play patterns — warn-only tier
//              for context files, memory entries, and tool results.
// - 'strict':  adds persistence / SSH / exfil-URL / hardcoded-secret
//              patterns — block-tier checks for user-mediated writes where
//              a false positive can be resolved interactively.

export const INTAKE_SCAN_SCOPES = ['all', 'context', 'strict'] as const;

export type IntakeScanScope = typeof INTAKE_SCAN_SCOPES[number];

// ── Findings and results ──

export interface IntakeScannerFinding {
  /** Rule/detector name. For rule-file rules this doubles as the audit id. */
  ruleId: string;
  /** Envelope taxonomy labels this finding contributes. May be empty for score-only structural findings. */
  labels: readonly IntakeRiskLabel[];
  /** Score contribution in (0, 1]. Combined per scanner via noisy-or. */
  weight: number;
  /** Narrowest scope tier this finding belongs to (already scope-filtered when emitted). */
  scope: IntakeScanScope;
  /** Human-auditable detail. Must never carry raw payload bytes. */
  detail?: string;
  /** Bounded evidence for an owner-file rule match; absent for other detectors. */
  match?: IntakeL1RuleMatchProvenance;
}

export interface IntakeScannerResult {
  scannerId: string;
  /** Deduplicated union of finding labels. */
  labels: readonly IntakeRiskLabel[];
  /** Calibrated 0–1 score for this scanner (envelope `scores[scannerId]`). */
  score: number;
  findings: readonly IntakeScannerFinding[];
  /** Transformed text when the scanner sanitizes (llm-guard transform contract). */
  sanitized?: string;
  /** Safe schema-extracted metadata (envelope `extractedFields` candidates). */
  extracted?: Readonly<Record<string, string>>;
}

export interface IntakeL1ScannerError {
  scannerId: string;
  message: string;
}

export interface IntakeL1ScanReport {
  scope: IntakeScanScope;
  /** True when the input exceeded MAX_SCAN_CHARS and was capped pre-regex. */
  truncated: boolean;
  /** Deduplicated union across scanners — envelope riskLabels input. */
  riskLabels: readonly IntakeRiskLabel[];
  /** Per-scanner 0–1 scores keyed by scanner id — envelope scores input. */
  scores: Readonly<Record<string, number>>;
  results: readonly IntakeScannerResult[];
  /**
   * Invisible-stripped, datamark-stripped, NFKC-normalized, secret-redacted
   * text (capped). Substituting it for the raw content is a policy decision
   * (htm9.3 'sanitize'), not L1's.
   */
  sanitizedText: string;
  /** True when sanitizedText differs from the original input. */
  sanitizedDiffers: boolean;
  /** Merged scanner extractions, keyed `<scannerId>.<key>` — envelope extractedFields input. */
  extractedFields: Readonly<Record<string, string>>;
  /** Scanner failures (fail-open-advisory: visible, never swallowed). */
  scannerErrors: readonly IntakeL1ScannerError[];
  elapsedMs: number;
}

export const INTAKE_MARKING_INTENSITIES = [
  'none',
  'wrap',
  'interleave',
  'summary_only',
] as const;

export type IntakeMarkingIntensity = typeof INTAKE_MARKING_INTENSITIES[number];

export function isIntakeMarkingIntensity(value: unknown): value is IntakeMarkingIntensity {
  return typeof value === 'string'
    && (INTAKE_MARKING_INTENSITIES as readonly string[]).includes(value);
}

export interface IntakeMarkingPlan {
  intensity: IntakeMarkingIntensity;
  /** Calm, factual provenance note rendered with the wrapper. */
  provenanceNote: string;
}

/**
 * Content-free account of whether each semantic layer ran and what verdict it
 * produced. Scores and labels remain on the envelope; this trace supplies the
 * missing routing reason that lets an operator distinguish a gated-off layer
 * from a layer that ran and returned clear.
 */
export interface IntakeSemanticScreeningTrace {
  l2: {
    status: 'not_run' | 'clear' | 'flagged' | 'failed_closed';
    reason: string;
  };
  l3: {
    status: 'not_run' | 'clear' | 'flagged' | 'failed_closed';
    reason: string;
  };
}

// ── Screening input/result ──
// (Decision label families live in risk-label-families.ts, re-exported above.)

/**
 * A screening signal produced by an UPSTREAM screener that ran before this
 * service — e.g. the htm9.8 vision screener whose VLM flags an image's
 * embedded instruction text before the OCR transcript is L1-scanned here.
 * Prior labels are folded into the envelope and participate in the decision:
 * a quarantine-family prior label quarantines exactly like an L1 finding
 * (fail-closed aggregation across screening layers — a cleaner transcript
 * never launders a flagged image).
 */
export interface IntakePriorScreeningSignal {
  /** Scanner identity for `envelope.scores` / extracted-field attribution. */
  scannerId: string;
  labels: IntakeRiskLabel[];
  /** Optional calibrated score recorded under `scannerId` in `scores`. */
  score?: number;
  /** Audit fields merged onto the envelope (caller owns key naming). */
  extractedFields?: Record<string, string>;
}

export interface IntakeScreeningInput {
  sourceClass: IntakeSourceClass;
  /** Trusted scheduler provenance used to prove a narrow internal tool-result class. */
  toolResultProvenance?: { toolName: string; arguments: unknown };
  /**
   * STRUCTURAL clean-bubble provenance, set ONLY by an authenticated call site
   * from tool/identity (never content). When the source class is internal
   * (tool_output / companion_self) this resolves the CogSec vector that drives
   * the centralized enforce/monitor decision; external ingress source classes
   * ignore it, so forged content cannot claim the clean bubble. Absent =
   * 'external' (screened normally).
   */
  structuralProvenance?: CogSecProvenanceClass;
  /**
   * Structurally authenticated channel/workflow identity. Unknown values are
   * rejected; content and origin strings never participate in resolution.
   */
  surface?: CogSecStructuralSurface;
  /** Origin locator: url, `discord:<channel>:<message>`, tool call id, ... */
  origin: { ref: string; detail?: string };
  scope: IntakeScanScope;
  /** What the envelope covers on the carrying message. Default `{kind:'body'}`. */
  subject?: IntakeEnvelopeSubject;
  /**
   * Canonical contact id of the sender, when the surface knows one. Matched
   * against the trustedPeople/deniedPeople source lists (htm9.13).
   */
  canonicalContactId?: string;
  /** Canonical channel classification supplied by the authenticated surface. */
  channelPrivacy?: ChannelPrivacy;
  /**
   * Canonical, content-free evidence for the narrow owner-configured private
   * direct-chat handling rule. Missing or contradictory fields simply retain
   * the ordinary stricter screening path.
   */
  chatBodyContext?: {
    channelClass: IntakeChatBodyChannelClass;
    conversationScope: ConversationScope;
    contactTrust: {
      contactId: string;
      trustLevel: TrustLevel;
      resolvedAtMs: number;
      archived: boolean;
    };
  };
  /**
   * Signals from screeners that already ran on this content upstream (htm9.8
   * vision screener). Folded into the envelope; quarantine-family prior labels
   * force a quarantine decision (fail closed across layers).
   */
  priorSignals?: readonly IntakePriorScreeningSignal[];
  /**
   * Carrying channel id, when the surface knows one. Recorded on the
   * CogSecEvent when the item reaches the L3 heavy screener (htm9.7 hard
   * rule); absent, the escalation port derives a source-class identifier.
   */
  sourceChannelId?: string;
  /** Transport-authoritative message identity for post-incident correlation. */
  sourceMessageId?: string;
  /**
   * On-disk artifact paths carrying this item's raw content (a saved
   * document and its parsed-text sidecar). Registered on the quarantine hold
   * so read seams can refuse to serve a quarantined artifact and record the
   * attempt for the operator (hrmrq.54).
   */
  artifactPaths?: readonly string[];
  /** Content-free message correlation for bounded live latency telemetry. */
  timing?: IntakeScreeningTimingContext;
  atMs?: number;
}

export type IntakeScreeningTimingStage = 'local_screening' | 'l2' | 'l3';

export type IntakeScreeningTimingStatus = 'observed' | 'not_run';

export interface IntakeScreeningTimingContext {
  traceId: string;
  turnId?: string;
  requestId?: string;
  channelId?: string;
  channelType?: string;
}

/**
 * Canonical content-free decision record emitted for every completed
 * screening, including released items. Raw text, safe summaries, origin refs,
 * and model output never ride this surface.
 */
interface IntakeScreeningObservabilityEvent {
  envelopeId: string;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  state: IntakeEnvelope['state'];
  action: IntakeDecisionAction;
  riskLabels: readonly IntakeRiskLabel[];
  scores: Readonly<Record<string, number>>;
  /** Verdicts supplied by upstream layers such as the image/OCR screener. */
  priorVerdicts: Readonly<Record<string, 'clear' | 'flagged'>>;
  semanticTrace: IntakeSemanticScreeningTrace;
}

export interface IntakeScreeningResult {
  /** The envelope in its post-screening state (released/…/quarantined). */
  envelope: IntakeEnvelope;
  /** Point-in-time projection for MessageRoutingMetadata / session metadata. */
  snapshot: IntakeEnvelopeSnapshot;
  report: IntakeL1ScanReport;
  action: IntakeDecisionAction;
  /** Per-item enforcement posture under which this item was evaluated. */
  mode: IntakeEnforcementPosture;
  /** Canonical global CogSec mode active when this item was screened. */
  globalMode: CogSecMode;
  /**
   * The declared CogSec vector resolved for this item (content-free; derived
   * from structural provenance). Feeds the centralized decision telemetry.
   */
  cogsecVector: CogSecVector;
  /** Content-free layer scores, escalation routing, and downstream verdicts. */
  observability: IntakeScreeningObservabilityEvent;
  /**
   * Text for downstream use. Shadow mode: always the original input. Enforce
   * mode: original on 'pass', L1 sanitized text on 'sanitize', the fixed
   * htm9.12 withheld-content placeholder on 'quarantine'.
   */
  effectiveText: string;
  /** True when enforce-mode quarantine withheld the content. */
  withheld: boolean;
  /** L1.5 score when a scorer ran; absent for L1-only screening. */
  injectionScore?: number;
  /** Visible-not-swallowed L1.5 failure (screening continued on L1 signals). */
  injectionScorerError?: string;
  /**
   * Visible-not-swallowed failure writing a quarantined item to the durable
   * quarantine store (htm9.11). The content stays withheld in enforce mode
   * regardless (fail closed) — only the operator review copy was lost.
   */
  quarantineHoldError?: string;
  /**
   * Data-marking plan (htm9.13) for markable source classes
   * (INTAKE_MARKING_SOURCE_CLASSES): a pure function of the screening labels,
   * max score, and effective tier. Computed and audited in BOTH modes; never
   * applied to effectiveText here — the prompt-assembly read side
   * (intake-sink-gating.ts) applies it in enforce mode, so inbound re-scans
   * never see legitimate markers.
   */
  markingPlan?: IntakeMarkingPlan;
  /**
   * The auditable CogSecEvent written when the item reached the L3 heavy
   * screener (htm9.7 hard rule: every L3 invocation writes one). Absent for
   * items that never escalated to L3.
   */
  cogSecCaseId?: string;
  /** Deep layers were scheduled after pass-through and have not settled yet. */
  postEscalation?: 'pending';
  /**
   * Content-addressed admission receipt (psfn-framework-1fjvm.3), present only
   * when a receipt writer is wired AND this result is a complete admission of
   * fully screened bytes (see `cogSecReceiptSuppression`). Its absence is
   * never a claim about the content: a consumer without a receipt screens.
   */
  receipt?: CogSecReceipt;
  /**
   * Visible-not-swallowed failure minting or persisting the admission receipt.
   * The screening decision stands either way; only the reusable proof was
   * lost, so the next consumer of these bytes screens them again.
   */
  receiptIssuanceError?: string;
  /**
   * Why this result carries no receipt (psfn-framework-ccgdz.2). Every
   * completed screening answers the receipt question with exactly one of
   * `receipt`, `receiptIssuanceError`, or this typed reason — a result never
   * says nothing about its own admission proof, so "no receipt" can never be
   * read as either "admitted" or "an oversight".
   */
  receiptAbsence?: IntakeReceiptAbsenceReason;
}

/**
 * Closed vocabulary for "this screening produced no admission receipt".
 *
 * The first four are properties of the CALL: no writer is wired, the caller
 * used the synchronous path (durable receipt persistence is asynchronous),
 * zero scanners ran (clean bubble — certifying it would let a consumer skip
 * screening that never happened), or the bounded pool failed closed before
 * screening completed. The rest mirror `cogSecReceiptSuppression`: properties
 * of the RESULT that make it not a complete admission of fully screened bytes.
 */

export type IntakeReceiptAbsenceReason =
  | 'no_receipt_writer'
  | 'sync_screening'
  | 'clean_bubble'
  | 'screening_incomplete'
  | 'deep_screening_pending'
  | 'not_admitted'
  | 'withheld'
  | 'envelope_not_consumable'
  | 'scan_truncated'
  | 'scanner_error'
  | 'injection_scorer_error';

export interface IntakePostEscalationEvent {
  phase: 'post_pass';
  disposition: 'clear' | 'confirmed_bad' | 'failed_closed';
  surface: CogSecStructuralSurface;
  envelopeId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  action: IntakeDecisionAction;
  riskLabels: readonly IntakeRiskLabel[];
  scores: Readonly<Record<string, number>>;
  semanticTrace: IntakeSemanticScreeningTrace;
  cogSecCaseId?: string;
  completedAtMs: number;
}

export interface IntakeInlineShadowFindingEvent
  extends Omit<IntakePostEscalationEvent, 'phase' | 'disposition'> {
  phase: 'inline_shadow';
  disposition: 'confirmed_bad';
}

export interface IntakeScreeningService {
  /** Ingress enforcement posture of this screening instance (observe/enforce). */
  readonly mode: IntakeEnforcementPosture;
  /** Canonical global CogSec mode this instance is running under. */
  readonly globalMode: CogSecMode;
  /**
   * Full screening: L1 plus the L1.5 scorer when configured. This is the ONLY
   * path that issues a content-addressed admission receipt; durable-artifact
   * admission consumers must use it rather than `screenSync`.
   */
  screen(text: string, input: IntakeScreeningInput): Promise<IntakeScreeningResult>;
  /**
   * Synchronous L1-only screening for sync call sites (session-entry
   * recording). Fails closed when an async scorer is configured: silently
   * skipping a configured screening layer is not allowed. It never issues a
   * receipt — durable receipt persistence is asynchronous — so its results
   * carry no reusable admission proof.
   */
  screenSync(text: string, input: IntakeScreeningInput): IntakeScreeningResult;
  /**
   * The screening-contract digest THIS service would bind a receipt to for
   * `input`, or null when that is not statically knowable
   * (psfn-framework-1fjvm.1/.2).
   *
   * Durable-artifact admission needs the CURRENT contract digest to ask the
   * receipt store whether these exact bytes are already admitted, WITHOUT
   * screening them first — otherwise reuse could never avoid the scan it
   * exists to avoid. Every field of the digest except the scanner set and the
   * semantic-layer outcomes is a pure function of `input` and this instance's
   * wiring, the L1 scanner set is content-independent
   * (`INTAKE_L1_SCANNER_IDS`), and an L1-only instance never runs L2/L3 — so
   * an L1-only service can answer exactly, and any other service answers null.
   *
   * A null answer, or a stale digest after a policy/rule/mode change, can only
   * deny reuse and force a rescreen. It can never grant admission: the digest
   * is an input to a store lookup whose result is still verified against the
   * exact bytes, the issuer set, and the clock.
   */
  screeningContractDigest(input: IntakeScreeningInput): string | null;
}
