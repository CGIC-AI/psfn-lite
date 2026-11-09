// Chain of custody on the artifact (files and images) egress surface
// (psfn-framework-ccgdz.6). Outward file egress carries the same requirement as
// text: an unprovable share is not an operator decision, it is a chain that
// does not exist, so it is held before the approval queue ever sees it.

import { describe, expect, it, vi } from 'vitest';

import { authorizeArtifactEgress, authorizeRecoveredArtifactEgress } from './sensitivity-egress.js';
import { classifyArtifactSensitivity } from '../../shared/contracts/artifact-sensitivity.js';
import { createApprovalQueuePortFromConfirmationQueue } from '../../system/capabilities/approval-queue-port.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import type { Attachment } from '../../shared/contracts/runtime.js';

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const ROOM_CHANNEL = 'discord:public-room';

const attachment: Attachment = {
  url: 'https://images.example.test/art.png',
  contentType: 'image/png',
  name: 'art.png',
  localPath: '/workspace/images/art.png',
};

const publicClassification = classifyArtifactSensitivity(
  [{ ref: 'memory:public-note', sensitivity: 'public' }],
  new Date('2026-07-16T12:00:00.000Z'),
);

const PROVEN = {
  custodySnapshotRef: `turn:${TURN_ID}`,
  sourceCount: 2,
  hasUnclassifiedSource: false,
  classification: 'auto_shareable',
  effectiveSensitivity: 'public',
};

function fakeStore() {
  const rows: unknown[] = [];
  return {
    rows,
    port: {
      record: vi.fn(async (record: unknown) => {
        rows.push(record);
        return 'recorded' as const;
      }),
      getByDeliveryRef: async () => null,
      listByGenerationContextRef: async () => [],
      close: async () => {},
    },
  };
}

function custodyDeps(input: {
  store: ReturnType<typeof fakeStore>;
  proof: typeof PROVEN | undefined;
  mode: CogSecMode;
}) {
  return {
    turnId: TURN_ID,
    proof: input.proof,
    resolveChannel: () => ({ channelPrivacy: 'public', broadcast: false }),
  };
}

describe('artifact egress custody', () => {

  it('leaves self and primary-contact delivery untouched', async () => {
    const store = fakeStore();
    const decision = await authorizeArtifactEgress({
      attachments: [attachment],
      classification: publicClassification,
      destination: {
        audience: 'primary_contact',
        channelId: 'discord:dm-v',
        channelType: 'discord',
        surface: 'conversation',
      },
      deps: {
        executeApprovedShare: vi.fn(async () => {}),
        readCurrentClassifications: async () => [publicClassification],
        custody: custodyDeps({ store, proof: undefined, mode: 'strict' }),
      },
    });

    expect(decision).toEqual({ disposition: 'proceed', attachments: [attachment] });
    expect(store.rows).toHaveLength(0);
  });

});
