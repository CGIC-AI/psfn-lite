import { describe, expect, it, vi } from 'vitest';

import type { ShardFoldReviewRecord, ShardFoldReviewPort } from '../../faculties/shards/fold-review.js';
import { buildShardLineageEnvelope } from '../../faculties/shards/result-lineage.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  FoldPackageDoingMirrorSource,
} from './sources.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function review(companionId: typeof COMPANION_ID, shardId: string): ShardFoldReviewRecord {
  return {
    schemaVersion: 1,
    shardId,
    channelId: `shard:${shardId}`,
    task: 'Sketch a seasonal planting plan',
    lineage: buildShardLineageEnvelope({
      kind: 'spawn',
      coreCompanionId: companionId,
      shardId,
      shardChannelId: `shard:${shardId}`,
      sourceMessage: {
        id: 'source-message',
        channelId: 'garden-room',
        channelType: 'api',
        authorId: companionId,
        authorName: 'Companion',
        timestamp: new Date(100),
      },
    }),
    validationPath: `/api/admin/shards/${shardId}`,
    reviewState: 'pending',
    createdAt: 100,
    updatedAt: 100,
    blockingReasons: [],
    visibilitySignals: {
      emotionalOrRelational: false,
      provenanceTags: [],
      emotionalOrRelationalOutputIds: [],
    },
    memoryItems: [],
    artifactItems: [],
  };
}

describe('doing-mirror source adapters', () => {
  it('projects fold packages only when both canonical companion lineage fields agree', async () => {
    const fold = review(COMPANION_ID, 'fold-1');
    const port: Pick<ShardFoldReviewPort, 'listFoldReviews' | 'getFoldReview'> = {
      listFoldReviews: vi.fn(async () => [fold]),
      getFoldReview: vi.fn(async () => fold),
    };
    const source = new FoldPackageDoingMirrorSource(port, COMPANION_ID);

    await expect(source.get('fold-1')).resolves.toMatchObject({
      itemType: 'fold_package',
      itemId: 'fold-1',
      ref: 'fold:fold-1',
      origin: {
        kind: 'companion',
        provenanceRefs: expect.arrayContaining([
          'companion:11111111-1111-4111-8111-111111111111',
          'shard:fold-1',
        ]),
      },
    });

    fold.lineage.companionProvenance.parentCompanionId = createCompanionId(
      '22222222-2222-4222-8222-222222222222',
    );
    await expect(source.list()).rejects.toThrow('does not prove origin from this companion');
  });
});