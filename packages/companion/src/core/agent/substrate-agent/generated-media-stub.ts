// ── Generated-media surface without image generation ──
//
// Lite extraction (seam 3.13, images cut). The turn loop reads generated
// image deliverables from the donor's src/primitives/images/generated-media.ts.
// The image tools that produce them (IMAGE_TOOL_NAMES: generate_image,
// selfie_create, media, image_create, image_edit) are cut with the image
// primitives, so a turn never carries an image tool result.
//
// Verbatim from the donor at e6a9546: GeneratedImageGalleryContext,
// ChargedImageDeliverableSummary, readGeneratedImageSensitivityClassifications
// (with GENERATED_IMAGE_META_SUFFIX) and mergeChargedImageDeliverableSummaries.
// Stubbed: summarizeChargedImageDeliverables,
// summarizePendingPaidImageDeliverables and collectGeneratedImageAttachments
// return [] — the donor result for a turn with no image tool result.
import { readFile } from 'node:fs/promises';
import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { Attachment } from '../../../shared/contracts/runtime.js';
import type { PendingPaidDeliverable } from '../../../shared/paid-deliverable-tracking.js';
import {
  parseArtifactSensitivityClassification,
  type ArtifactSensitivityClassification,
  type ArtifactSensitivitySource,
} from '../../../shared/contracts/artifact-sensitivity.js';
import { isRecord } from '../../../shared/utils/types.js';

const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';

export interface GeneratedImageGalleryContext {
  channelId?: string;
  channelType?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  userSessionEntryId?: number;
  assistantSessionEntryId?: number;
  /** Content-free sources actually present in the context used to create the image. */
  sensitivitySources?: readonly ArtifactSensitivitySource[];
  /** Precomputed once so the durable sidecar and egress approval fingerprint are identical. */
  sensitivityClassification?: ArtifactSensitivityClassification;
}

export async function readGeneratedImageSensitivityClassifications(
  attachments: readonly Attachment[],
): Promise<ArtifactSensitivityClassification[]> {
  const classifications: ArtifactSensitivityClassification[] = [];
  for (const attachment of attachments) {
    const localPath = attachment.localPath?.trim();
    if (!localPath) {
      throw new Error('Artifact sensitivity verification requires a persisted local image');
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(`${localPath}${GENERATED_IMAGE_META_SUFFIX}`, 'utf-8'));
    } catch (error) {
      throw new Error(`Artifact sensitivity metadata is unavailable: ${String(error)}`);
    }
    if (!isRecord(metadata)) {
      throw new Error('Artifact sensitivity metadata must be a JSON object');
    }
    const classification = parseArtifactSensitivityClassification(metadata.sensitivityClassification);
    if (!classification) {
      throw new Error('Artifact sensitivity metadata is missing or invalid');
    }
    classifications.push(classification);
  }
  return classifications;
}

export interface ChargedImageDeliverableSummary {
  toolName: string;
  toolCallId?: string;
  requestId?: string;
  imageCount: number;
}

export function summarizeChargedImageDeliverables(
  _turnMessages: AgentMessage[],
): ChargedImageDeliverableSummary[] {
  return [];
}

export function summarizePendingPaidImageDeliverables(
  _deliverables: readonly PendingPaidDeliverable[],
): ChargedImageDeliverableSummary[] {
  return [];
}

export function mergeChargedImageDeliverableSummaries(
  primary: readonly ChargedImageDeliverableSummary[],
  fallback: readonly ChargedImageDeliverableSummary[],
): ChargedImageDeliverableSummary[] {
  const merged: ChargedImageDeliverableSummary[] = [];
  const seen = new Set<string>();
  for (const summary of [...primary, ...fallback]) {
    const key = summary.requestId ?? summary.toolCallId ?? `${summary.toolName}:${summary.imageCount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...summary });
  }
  return merged;
}

export async function collectGeneratedImageAttachments(_params: {
  turnMessages: AgentMessage[];
  /** Authenticated companion Personal Workspace, never companion runtime data. */
  personalFilesDir: string;
  fetchImpl?: typeof fetch;
  galleryContext?: GeneratedImageGalleryContext;
  paidDeliverables?: readonly PendingPaidDeliverable[];
}): Promise<Attachment[]> {
  return [];
}
