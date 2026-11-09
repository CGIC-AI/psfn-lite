// ── Prompt-assembly sink gate over session entries (htm9.3) ──

import { describe, expect, it, vi } from 'vitest';
import type { IntakeSinkGate } from '../../shared/contracts/intake-sink-gate-port.js';
import type { IntakeSink } from '../../shared/contracts/intake-envelope.js';
import {
  applyPromptAssemblySinkGate,
  screenSelfAuthoredMutation,
  type SelfAuthoredMutationIntakeRuntime,
} from './intake-sink-gating.js';
import type { SessionEntry } from './types.js';

function makeEntry(input: {
  id: number;
  content: string;
  metadata?: string;
}): SessionEntry {
  return {
    id: input.id,
    channelId: 'discord:chan-1',
    role: 'user',
    content: input.content,
    authorId: 'user-1',
    authorName: 'User One',
    timestamp: 1_700_000_000_000,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  } as SessionEntry;
}

describe('applyPromptAssemblySinkGate (htm9.3)', () => {
  const promptAttempt = {
    channelId: 'discord:chan-1',
    attemptRef: 'prompt-assembly-attempt-1',
  };

  it('is a no-op without a gate (firewall off)', () => {
    const entries = [makeEntry({ id: 1, content: 'hello' })];
    const result = applyPromptAssemblySinkGate(entries, null, promptAttempt);
    expect(result.entries).toBe(entries);
    expect(result.summary.withheldEntryIds).toEqual([]);
  });
});

describe('screenSelfAuthoredMutation', () => {
  const mutationSinks = [
    'persona_mutation',
    'wiki_write',
    'trust_mutation',
  ] as const satisfies readonly IntakeSink[];

  it.each(mutationSinks)('fails loudly before an empty-envelope %s evaluation', async (sink) => {
    const evaluate = vi.fn();
    const gate = {
      mode: 'enforce',
      evaluate,
      assessEgressTrifecta: vi.fn(),
    } as unknown as IntakeSinkGate;
    const runtime: SelfAuthoredMutationIntakeRuntime = {
      getIntakeSinkGate: () => gate,
      getIntakeScreening: () => null,
      getActiveTurnIntakeEnvelopes: () => [],
    };

    await expect(screenSelfAuthoredMutation(
      sink,
      { action: 'update', content: 'benign' },
      runtime,
      { tool: 'test', action: 'update', attemptRef: 'mutation-attempt-1' },
    )).rejects.toThrow(/screening is unavailable/);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(mutationSinks)('rejects a zero-string %s mutation before gate evaluation', async (sink) => {
    const evaluate = vi.fn();
    const gate = {
      mode: 'enforce',
      evaluate,
      assessEgressTrifecta: vi.fn(),
    } as unknown as IntakeSinkGate;
    const runtime: SelfAuthoredMutationIntakeRuntime = {
      getIntakeSinkGate: () => gate,
      getIntakeScreening: () => ({ screen: vi.fn() }) as unknown as ReturnType<SelfAuthoredMutationIntakeRuntime['getIntakeScreening']>,
      getActiveTurnIntakeEnvelopes: () => [],
    };

    await expect(screenSelfAuthoredMutation(
      sink,
      { version: 1, enabled: true },
      runtime,
      { tool: 'test', action: 'update', attemptRef: 'mutation-attempt-1' },
    )).rejects.toThrow(/no textual content|empty-envelope/);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
