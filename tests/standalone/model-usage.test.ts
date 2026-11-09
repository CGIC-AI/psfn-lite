import { describe, expect, it } from 'vitest';
import { createModelUsageLedger } from '../../apps/standalone/src/model-usage.ts';
import type { ModelUsageEventInput } from '../../apps/standalone/src/companion.ts';

function event(overrides: Partial<ModelUsageEventInput> & { lane?: ModelUsageEventInput['attribution']['runtimeLaneClass'] }): ModelUsageEventInput {
  const { lane, ...rest } = overrides;
  return {
    logicalCallId: 'call-1',
    status: 'success',
    callKind: 'completion',
    attribution: { callType: 'background', purpose: 'background', ...(lane === undefined ? {} : { runtimeLaneClass: lane }) },
    provider: 'host',
    model: 'model-a',
    ...rest,
  };
}

describe('standalone model-usage ledger', () => {
  it('totals calls, failures, tokens and effective cost by lane and by model', async () => {
    const ledger = createModelUsageLedger();
    await ledger.recordUsageEvent(event({ lane: 'foreground_chat', callKind: 'chat', inputTokens: 100, outputTokens: 20, effectiveCostUsd: 0.5 }));
    await ledger.recordUsageEvent(event({ lane: 'post_turn_appraisal', inputTokens: 40, outputTokens: 5, totalTokens: 50, effectiveCost: { total: 0.25 } }));
    await ledger.recordUsageEvent(event({ lane: 'post_turn_appraisal', status: 'failure', model: 'model-b' }));
    await ledger.recordUsageEvent(event({ callKind: 'embedding', inputTokens: 7 }));

    const snapshot = ledger.snapshot();
    expect(snapshot.total).toEqual({ calls: 4, failures: 1, inputTokens: 147, outputTokens: 25, totalTokens: 177, costUsd: 0.75 });
    expect(snapshot.byLane['post_turn_appraisal']).toEqual({ calls: 2, failures: 1, inputTokens: 40, outputTokens: 5, totalTokens: 50, costUsd: 0.25 });
    expect(snapshot.byLane['unknown']?.calls).toBe(1);
    expect(Object.keys(snapshot.byModel).sort()).toEqual(['host/model-a', 'host/model-b']);
  });

  it('ignores negative and non-finite counts', async () => {
    const ledger = createModelUsageLedger();
    await ledger.recordUsageEvent(event({ inputTokens: -3, outputTokens: Number.NaN, effectiveCostUsd: Number.POSITIVE_INFINITY }));
    expect(ledger.snapshot().total).toEqual({ calls: 1, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });
  });
});
