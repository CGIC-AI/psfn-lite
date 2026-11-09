import { mkdtempSync, rmSync } from 'node:fs';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { EventBus } from '../../../shared/event-bus.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { LLMResponse } from '../../../shared/contracts/runtime.js';
import { wireSubagentRuntime } from './composition.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';

// Lite: the donor's wireShardAndThinkRuntime is cut to wireSubagentRuntime
// (seam 3.11; the shard manager, the analysis workbench, its module loader
// and the sandbox are cut). The donor test of the subagent surface is kept
// over wireSubagentRuntime (extraction/modified-tests.tsv); the tests of the
// cut parts are in extraction/deleted-tests.tsv.

type CapabilityTier = 'nursery' | 'apprentice' | 'autonomous';
const EMPTY_MEMORY_STORE = {
  getStats: () => ({
    total: 0,
    avgSalience: 0,
    byType: {},
  }),
};
const snapshotParentCapabilityGrant = (): CapabilityGrantSnapshot => Object.freeze({
  tier: 'custom',
  customTokens: Object.freeze(['shard.spawn']),
  grantedTokens: Object.freeze(['shard.spawn']),
});

const dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface GatewayLLMProvider extends LLMProviderPort {
  fsRead: (path: string) => Promise<string>;
  fsWrite: (path: string, content: string) => Promise<void>;
}

function mockResponse(content: string, inputTokens = 10, outputTokens = 20): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'mock',
    inputTokens,
    outputTokens,
    stopReason: 'stop',
  };
}

class FakeSubstrateAgent {
  memoryProvider = null;
  tools: AgentTool<any>[] = [];
  registrations: Array<{ tool: AgentTool<any>; category: 'core' | 'extended' }> = [];

  registerTool(tool: AgentTool<any>, category: 'core' | 'extended' = 'core'): void {
    this.tools.push(tool);
    this.registrations.push({ tool, category });
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: this.registrations
        .filter((entry) => entry.category === 'core')
        .map((entry) => entry.tool),
      extended: this.registrations
        .filter((entry) => entry.category === 'extended')
        .map((entry) => entry.tool),
    };
  }
}

function wireSplitThinkTool(options: {
  tier: CapabilityTier;
  llmProvider: LLMProviderPort;
  eventBus: EventBus;
}): FakeSubstrateAgent {
  const target = new FakeSubstrateAgent();
  const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-subagent-surface-'));
  dataDirs.push(companionDataDir);
  wireSubagentRuntime({
    snapshotParentCapabilityGrant,
    agentLoop: fromAny(target),
    eventBus: options.eventBus,
    llmProvider: options.llmProvider,
    sessionStore: fromPartial<Record<string, unknown>>({}),
    embeddingService: null,
    memoryStore: fromAny(EMPTY_MEMORY_STORE),
    sessionManager: fromPartial<Record<string, unknown>>({}),
    config: fromAny({
      capabilityTier: options.tier,
    }),
    parentSystemPrompt: 'test',
    companionDataDir,
  });
  return target;
}

describe('wireShardAndThinkRuntime split-mode module wiring', () => {
  it('registers subagent as the only canonical bounded-worker surface', () => {
    const llm: GatewayLLMProvider = {
      stream: vi.fn(),
      complete: vi.fn(async () => mockResponse('FINAL("noop")')),
      fsRead: vi.fn(async () => '[]'),
      fsWrite: vi.fn(async () => undefined),
    };
    const target = wireSplitThinkTool({
      tier: 'autonomous',
      llmProvider: llm,
      eventBus: new EventBus(),
    });

    expect(target.registrations.find((entry) => entry.tool.name === 'subagent')?.category).toBe('core');
    expect(target.registrations.some((entry) => entry.tool.name === 'spawn_subagent')).toBe(false);

    const registeredNames = new Set(target.registrations.map((entry) => entry.tool.name));
    const advertisedToolNames = target.registrations.flatMap((entry) => (
      [...entry.tool.description.matchAll(/\buse\s+([a-z][a-z0-9_]*)\s+action=/giu)]
        .map((match) => match[1])
    ));
    expect(advertisedToolNames.filter((name) => !registeredNames.has(name))).toEqual([]);
  });
});
