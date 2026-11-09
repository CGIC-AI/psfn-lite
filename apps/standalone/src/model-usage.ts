/**
 * The standalone host's model-usage recorder: the ModelUsageRecorder port the
 * companion core takes in place of the donor's Postgres model-usage store
 * (seam 3.1, docs/extraction.md). The core records every model and embedding
 * call through it; with no recorder its accountability guard refuses every
 * autonomous (non-foreground) model call.
 *
 * It keeps running totals in process memory, by runtime lane and by
 * provider/model. It holds no content, session, channel or contact ids, and
 * it is not durable: the totals start at zero on every start. The donor's
 * usage rows, usage queries, budget alerts and cost exports are cut.
 */
import type { ModelUsageEventInput, ModelUsageRecorder } from './companion.ts';

export interface ModelUsageTotals {
  readonly calls: number;
  readonly failures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** The call's effective cost (provider-reported, else estimated), when the core knew one. */
  readonly costUsd: number;
}

export interface ModelUsageSnapshot {
  readonly total: ModelUsageTotals;
  /** Keyed by the core's runtime lane class (`foreground_chat`, `post_turn_appraisal`, ...). */
  readonly byLane: Readonly<Record<string, ModelUsageTotals>>;
  /** Keyed by `provider/model`. */
  readonly byModel: Readonly<Record<string, ModelUsageTotals>>;
}

export interface ModelUsageLedger extends ModelUsageRecorder {
  snapshot(): ModelUsageSnapshot;
}

const ZERO: ModelUsageTotals = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function add(totals: ModelUsageTotals, event: ModelUsageEventInput): ModelUsageTotals {
  const inputTokens = count(event.inputTokens);
  const outputTokens = count(event.outputTokens);
  return {
    calls: totals.calls + 1,
    failures: totals.failures + (event.status === 'failure' ? 1 : 0),
    inputTokens: totals.inputTokens + inputTokens,
    outputTokens: totals.outputTokens + outputTokens,
    totalTokens: totals.totalTokens + (event.totalTokens === undefined ? inputTokens + outputTokens : count(event.totalTokens)),
    costUsd: totals.costUsd + count(event.effectiveCostUsd ?? event.effectiveCost?.total),
  };
}

export function createModelUsageLedger(): ModelUsageLedger {
  let total = ZERO;
  const byLane = new Map<string, ModelUsageTotals>();
  const byModel = new Map<string, ModelUsageTotals>();
  return {
    recordUsageEvent: (event) => {
      total = add(total, event);
      const lane = event.attribution.runtimeLaneClass ?? 'unknown';
      byLane.set(lane, add(byLane.get(lane) ?? ZERO, event));
      const model = `${event.provider}/${event.model}`;
      byModel.set(model, add(byModel.get(model) ?? ZERO, event));
      return Promise.resolve();
    },
    snapshot: () => ({ total, byLane: Object.fromEntries(byLane), byModel: Object.fromEntries(byModel) }),
  };
}
