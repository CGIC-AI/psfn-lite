// Lite cut (seam 3.11, extraction/cuts.tsv): the wishlist source and the
// closed-wish reconciliation are cut with the wiki (personal-wishlist.ts); the
// fold-package source over the kept fold-review queue is unchanged.
import type {
  ShardFoldReviewPort,
  ShardFoldReviewRecord,
} from '../../faculties/shards/fold-review.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';

import type {
  DoingMirrorSourceDispositionInput,
  DoingMirrorSourceItem,
  DoingMirrorSourcePort,
  DoingMirrorStorePort,
} from './contracts.js';

function assertFoldOrigin(record: ShardFoldReviewRecord, companionId: CompanionId): void {
  if (
    record.lineage.coreCompanionId !== companionId
    || record.lineage.companionProvenance.parentCompanionId !== companionId
    || record.lineage.shardId !== record.shardId
  ) {
    throw new Error(`fold package ${record.shardId} does not prove origin from this companion`);
  }
}

function foldSource(record: ShardFoldReviewRecord, companionId: CompanionId): DoingMirrorSourceItem {
  assertFoldOrigin(record, companionId);
  return {
    itemType: 'fold_package',
    itemId: record.shardId,
    ref: `fold:${record.shardId}`,
    title: record.task,
    summary: `Fold review state: ${record.reviewState}`,
    createdAt: record.createdAt,
    origin: {
      kind: 'companion',
      provenanceRefs: [
        `companion:${companionId}`,
        `shard:${record.shardId}`,
        `fold-review:${record.validationPath}`,
      ],
    },
  };
}

export class FoldPackageDoingMirrorSource implements DoingMirrorSourcePort {
  readonly itemType = 'fold_package' as const;

  constructor(
    private readonly folds: Pick<ShardFoldReviewPort, 'listFoldReviews' | 'getFoldReview'>,
    private readonly companionId: CompanionId,
  ) {}

  async list(): Promise<DoingMirrorSourceItem[]> {
    return (await this.folds.listFoldReviews()).map(record => foldSource(record, this.companionId));
  }

  async get(itemId: string): Promise<DoingMirrorSourceItem | null> {
    const record = await this.folds.getFoldReview(itemId);
    return record ? foldSource(record, this.companionId) : null;
  }
}
