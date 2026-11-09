/**
 * Memory deletion approved by the host's human (docs/extraction.md, Step E3),
 * over the real standalone runtime: the donor `memory` tool's delete creates
 * a pending proposal and leaves the memory active; only the host's approval
 * of the call that created it, from the turn that made the call, deletes it.
 * A proposal from the operator's own (non-host) turn stays pending.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { Script } from '../support/faux-model.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { RUNTIME_TIMEOUT_MS } from '../support/lite-world.ts';
import { INSTALL, bridge, mcpClient, useBridgeWorld, type BridgeWorld } from './bridge-world.ts';

const EXPLANATION = 'The stored number is incorrect.';
const PI_REQUEST = 'Please forget the incorrect note';

/** The operator's own turn: the model asks to delete the memory named in the message, then replies with the tool result. */
const script: Script = (call) => {
  if (!call.lastUser.includes(PI_REQUEST) || (call.context.tools?.length ?? 0) === 0) return null;
  const memoryId = /memory ([0-9a-f-]{36})/.exec(call.lastUser)?.[1] ?? '';
  const messages = call.context.messages;
  const results = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1).filter((m) => m.role === 'toolResult');
  if (results.length === 0) {
    return { toolCalls: [{ name: 'memory', arguments: { action: 'delete', memory_id: memoryId, justification_category: 'factually_incorrect', explanation: EXPLANATION } }] };
  }
  return results[0]!.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
};

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.structuredContent as { text?: string } | undefined)?.text ?? JSON.stringify(result.structuredContent);
  expect(result.isError ?? false, text).toBe(false);
  return text;
}

describe.skipIf(dockerTestsOptedOut('lifecycle memory deletion'))('memory deletion approved by the host', () => {
  const world = useBridgeWorld(script);

  const memory = (w: BridgeWorld) => w.runtime.companion.persistence.memoryStore;
  const proposals = (w: BridgeWorld) => w.runtime.companion.persistence.memoryDeletionProposalStore;

  /** One host-driven turn of the operator: run `body` inside it, then settle. */
  async function hostTurn<T>(w: BridgeWorld, key: string, body: (client: Client) => Promise<T>): Promise<T> {
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: key, sessionId: 'session-del', message: `turn ${key}` });
    expect(prepared.body['kind']).toBe('prepared');
    const client = await mcpClient(w, operator);
    try {
      return await body(client);
    } finally {
      await client.close();
      await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Done.' } });
    }
  }

  async function remember(w: BridgeWorld, key: string, text: string): Promise<string> {
    const written = await hostTurn(w, key, (client) => tool(client, 'memory', { action: 'write', text, type: 'semantic' }));
    const id = /id: ([0-9a-f-]{36})/.exec(written)?.[1];
    if (id === undefined) throw new Error(`no memory id in ${written}`);
    return id;
  }

  const approve = (w: BridgeWorld, credential: string, body: Record<string, unknown>) => bridge(w, 'memory-deletion/approve', credential, {
    hostInstance: 'hermes-1', hermesInstallId: INSTALL, ...body,
  });

  it('deletes a memory only when the host approves the call that proposed it', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const friend = w.credentials['hermes-friend'];
    const target = await remember(w, 'write-1', 'Robin\'s phone number is 555-0100');
    const other = await remember(w, 'write-2', 'Robin waters the tomatoes at dusk');

    const approvedId = await hostTurn(w, 'delete-1', async (client) => {
      const proposed = await tool(client, 'memory', { action: 'delete', memory_id: target, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      const proposalId = /Memory deletion proposal (\S+) is pending/.exec(proposed)?.[1] ?? '';
      expect(proposalId).not.toBe('');
      // The donor tool only proposes: the memory stays active until a human decides.
      expect((await memory(w).getById(target))?.deletedAt).toBeUndefined();
      expect((await proposals(w).getMemoryDeletionProposal(proposalId))?.status).toBe('pending_partner_alert');

      // Only the primary contact's principal, of the bound install, for the proposed memory, approves.
      expect((await approve(w, friend, { proposalId, memoryId: target })).status).toBe(403);
      expect((await approve(w, operator, { proposalId, memoryId: target, hermesInstallId: 'ffffffffffffffffffffffffffffffff' })).status).toBe(403);
      expect((await approve(w, operator, { proposalId, memoryId: other })).status).toBe(409);
      expect((await memory(w).getById(target))?.deletedAt).toBeUndefined();
      // The rejected attempt used up the request: the proposal stays pending until another approved call.
      expect((await approve(w, operator, { proposalId, memoryId: target })).status).toBe(404);
      expect((await memory(w).getById(target))?.deletedAt).toBeUndefined();

      const again = await tool(client, 'memory', { action: 'delete', memory_id: target, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      const second = /Memory deletion proposal (\S+) is pending/.exec(again)?.[1] ?? '';
      const approved = await approve(w, operator, { proposalId: second, memoryId: target });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ proposalId: second, status: 'approved' });
      expect(typeof approved.body['deleteId']).toBe('string');
      // Once only.
      expect((await approve(w, operator, { proposalId: second, memoryId: target })).status).toBe(404);
      return second;
    });
    expect((await memory(w).getById(target))?.deletedAt).toEqual(expect.any(Number));
    expect((await proposals(w).getMemoryDeletionProposal(approvedId))?.status).toBe('approved');
    // The other memory was never touched.
    expect((await memory(w).getById(other))?.deletedAt).toBeUndefined();
  }, RUNTIME_TIMEOUT_MS);

  it('leaves a proposal pending when its turn has ended or when the operator\'s own turn made it', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const kept = await remember(w, 'write-3', 'Robin keeps the spare key under the blue pot');
    let proposalId = '';
    await hostTurn(w, 'delete-2', async (client) => {
      const proposed = await tool(client, 'memory', { action: 'delete', memory_id: kept, justification_category: 'factually_incorrect', explanation: EXPLANATION });
      proposalId = /Memory deletion proposal (\S+) is pending/.exec(proposed)?.[1] ?? '';
    });
    // The turn settled (the host denied or never answered): no approval is accepted any more.
    expect((await approve(w, operator, { proposalId, memoryId: kept })).status).toBe(409);
    expect((await memory(w).getById(kept))?.deletedAt).toBeUndefined();

    const reply = await w.runtime.converse(`${PI_REQUEST}: memory ${kept}`);
    const piProposal = /Memory deletion proposal (\S+) is pending/.exec(reply.content)?.[1] ?? '';
    expect(piProposal).not.toBe('');
    const pending = await proposals(w).listPendingMemoryDeletionProposals();
    expect(pending.map((p) => p.id)).toEqual(expect.arrayContaining([proposalId, piProposal]));
    await hostTurn(w, 'approve-pi', async () => {
      expect((await approve(w, operator, { proposalId: piProposal, memoryId: kept })).status).toBe(404);
    });
    expect((await memory(w).getById(kept))?.deletedAt).toBeUndefined();
  }, RUNTIME_TIMEOUT_MS);
});
