/**
 * Memory deletion with no host approval port (docs/extraction.md, Step E3):
 * a standalone runtime without the lifecycle bridge passes no
 * MemoryDeletionApprovalPort, so the donor `memory` tool's delete answers
 * "not configured" (faculties/memory/tools.ts) and the memory stays active,
 * at the Lite default tier (autonomous) as at any other.
 */
import { describe, expect, it } from 'vitest';
import type { Script } from '../support/faux-model.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { RUNTIME_TIMEOUT_MS, useLiteWorld } from '../support/lite-world.ts';

const REMEMBER = 'Please remember: ';
const FORGET = 'Please forget memory ';

/** The operator's turn: one memory tool call named by the message, then the tool result as the reply. */
const script: Script = (call) => {
  if ((call.context.tools?.length ?? 0) === 0) return null;
  const messages = call.context.messages;
  const results = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).filter((m) => m.role === 'toolResult');
  if (results.length > 0) return results[0]!.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  if (call.lastUser.includes(REMEMBER)) {
    return { toolCalls: [{ name: 'memory', arguments: { action: 'write', text: call.lastUser.split(REMEMBER)[1] ?? '', type: 'semantic' } }] };
  }
  const memoryId = /memory ([0-9a-f-]{36})/.exec(call.lastUser)?.[1];
  if (call.lastUser.includes(FORGET) && memoryId !== undefined) {
    return { toolCalls: [{ name: 'memory', arguments: { action: 'delete', memory_id: memoryId, justification_category: 'factually_incorrect', explanation: 'The stored number is incorrect.' } }] };
  }
  return null;
};

describe.skipIf(dockerTestsOptedOut('standalone memory deletion'))('memory deletion without a host approval port', () => {
  const lite = useLiteWorld();

  it('answers "not configured" and keeps the memory', async () => {
    const install = await lite.install();
    expect(install.document.lifecycle).toBeNull();
    const { runtime } = await lite.start(install, script);
    const written = await runtime.converse(`${REMEMBER}Robin's phone number is 555-0100`);
    const memoryId = /id: ([0-9a-f-]{36})/.exec(written.content)?.[1];
    expect(memoryId, written.content).toBeDefined();

    const refused = await runtime.converse(`${FORGET}${memoryId!}`);
    expect(refused.content).toContain('memory deletion proposal persistence and confirmation are not configured');
    const memory = await runtime.companion.persistence.memoryStore.getById(memoryId!);
    expect(memory?.deletedAt).toBeUndefined();
    expect(await runtime.companion.persistence.memoryDeletionProposalStore.listPendingMemoryDeletionProposals()).toEqual([]);
  }, RUNTIME_TIMEOUT_MS);
});
