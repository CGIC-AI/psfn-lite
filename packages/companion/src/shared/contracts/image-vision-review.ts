// ── Vision review contract (type-only) ──
//
// Lite extraction (seam 3.13): the inbound vision-review port the turn loop
// accepts (`imageVisionReviewer`, null when no reviewer is wired) and the
// embodiment read it can return. Declarations copied verbatim from the
// donor's src/primitives/images/types.ts at e6a9546 (lines 44, 231-246,
// 258-278); the image generation and vision services themselves are cut.

export type ImageMode = 'create' | 'edit';

export type EmbodimentConsistencyVerdict = 'same_me' | 'drifted' | 'different_person';

/**
 * A companion-readable read on whether a new render still looks like the same
 * companion as the active reference. Charter 8.6: framing, not a score wall —
 * there is no numeric similarity value, and the review never auto-rejects.
 */
export interface ImageEmbodimentConsistency {
  verdict: EmbodimentConsistencyVerdict;
  /** Companion-facing framing derived from the verdict. */
  framing: string;
  /** The reviewer's short reason for the read. */
  note: string;
  referenceId: string;
  referenceDescription?: string;
}

export interface ImageVisionReview {
  question: string;
  summary: string;
  model: string;
  imageCount: number;
  embodiment?: ImageEmbodimentConsistency;
}

export interface ImageVisionReviewRequest {
  imageUrls: string[];
  imageLocalPaths?: string[];
  question?: string;
  prompt?: string;
  mode?: ImageMode;
  /** When true, compare the render(s) to the active reference for embodiment continuity. */
  compareToReference?: boolean;
}

export interface ImageVisionReviewer {
  analyze(input: ImageVisionReviewRequest): Promise<ImageVisionReview>;
}
