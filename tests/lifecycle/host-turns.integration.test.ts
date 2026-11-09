/**
 * Host-driven turns over the extracted companion core: an external host
 * (Hermes) prepares a turn, calls donor tools over MCP inside it and settles
 * it, and the donor SubstrateAgent does the rest: it assembles the context the
 * host's model sees, runs every tool call in its own loop, and records the
 * turn in its session archive when the host's final reply ends the loop. The
 * host's model answers replace the provider only for that turn: the faux
 * provider never sees the host's message.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHostSessionIntegrityProvider } from '../../apps/standalone/src/session-integrity.ts';
import { createSessionHmacBoundaryService, type JournalEntry, type SessionIntegrityProvider } from '../../apps/standalone/src/companion.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { RUNTIME_TIMEOUT_MS, COMPANION_NAME } from '../support/lite-world.ts';
import { INSTALL, bridge, mcpClient, useBridgeWorld } from './bridge-world.ts';

const HOST_MESSAGE = 'Hello from the host, what is on your mind today?';
const HOST_REPLY = 'I was thinking about the garden we planted.';
const HOST_TURN_TIMEOUT_MS = 8_000;
const OTHER_INSTALL = 'ffffffffffffffffffffffffffffffff';

/** Every session journal (the donor session store's files, `<companion state>/sessions/*.jsonl`) under the data directory, by file. */
function journals(dataDir: string): Map<string, JournalEntry[]> {
  const found = new Map<string, JournalEntry[]>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.jsonl') && dir.endsWith(join('state', 'sessions'))) {
        const entries = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as JournalEntry);
        if (entries.every((entry) => typeof entry.channelId === 'string' && typeof entry.type === 'string')) found.set(path, entries);
      }
    }
  };
  walk(dataDir);
  return found;
}

/** Verifies a journal's HMAC chain the way the donor store reads it: each entry against the previous entry's signature. */
function chainVerifies(provider: SessionIntegrityProvider, entries: readonly JournalEntry[]): boolean {
  let previous: string | null = null;
  for (const entry of entries) {
    if (!provider.verify(entry, previous).verified) return false;
    previous = entry._hmac ?? null;
  }
  return true;
}

describe.skipIf(dockerTestsOptedOut('lifecycle host-driven turns'))('host-driven turns', () => {
  // One runtime per process (donor readiness ledger); the timeout case needs a short host-turn timeout.
  const world = useBridgeWorld(() => null, { hostTurnTimeoutMs: HOST_TURN_TIMEOUT_MS, modelApi: 'openai-completions' });

  it('prepares the donor context, runs a donor tool in the turn and archives the settled turn', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(prepared.status).toBe(200);
    expect(prepared.body['kind']).toBe('prepared');
    expect(prepared.body['resumed']).toBe(false);
    const turnId = prepared.body['turnId'] as string;
    const context = prepared.body['context'] as { systemPrompt: string; messages: { role: string; text: string }[]; tools: string[] };
    expect(context.systemPrompt).toContain(COMPANION_NAME);
    expect(context.messages.filter((m) => m.role === 'user').at(-1)?.text).toContain(HOST_MESSAGE);
    expect(context.tools).toContain('orient');
    // No explicit tool request: the host's model chooses.
    expect((prepared.body['context'] as { toolChoice: unknown }).toolChoice).toBeNull();

    // The MCP surface is the donor catalog, one tool per donor tool.
    const client = await mcpClient(w, operator);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      for (const name of ['tool_search', 'toolset', 'orient', 'memory', 'scratchpad', 'contact', 'journal']) expect(names).toContain(name);

      // A tool call inside the open turn is run by the donor loop.
      const called = await client.callTool({ name: 'orient', arguments: { action: 'values_list' } });
      expect(called.isError ?? false).toBe(false);
      expect((called.structuredContent as { origin: string }).origin).toBe('tool_result');
    } finally {
      await client.close();
    }

    // Re-preparing the open key answers the same turn.
    const again = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(again.body).toMatchObject({ kind: 'prepared', turnId, resumed: true });

    const open = await bridge(w, 'checkpoint', operator, { hermesInstallId: INSTALL, sessionId: 'session-a', turnIds: [turnId] });
    expect(open.body).toEqual({ settled: [], open: [turnId] });

    const settled = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId, outcome: { kind: 'completed', reply: HOST_REPLY } });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ turnId, status: 'completed' });

    // The donor recorded the turn in its archive; a repeated settle answers the same; a replayed prepare is refused as recorded.
    const checkpoint = await bridge(w, 'checkpoint', operator, { hermesInstallId: INSTALL, sessionId: 'session-a', turnIds: [turnId] });
    expect(checkpoint.body).toEqual({ settled: [turnId], open: [] });
    const repeated = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId, outcome: { kind: 'completed', reply: HOST_REPLY } });
    expect(repeated.body).toEqual(settled.body);
    const replayed = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'msg-1', sessionId: 'session-a', message: HOST_MESSAGE });
    expect(replayed.body).toEqual({ kind: 'replayed' });

    // The provider never answered the host's turn.
    expect(w.model.calls.some((call) => call.lastUser.includes(HOST_MESSAGE))).toBe(false);
    expect(settled.body['reply']).toBe(HOST_REPLY);

    // The next turn of the session is assembled from the donor's archive: the first exchange is its history.
    const next = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'msg-2', sessionId: 'session-a', message: 'And after that?' });
    expect(next.body['kind']).toBe('prepared');
    const history = (next.body['context'] as { messages: { role: string; text: string }[] }).messages;
    expect(history.some((m) => m.role === 'user' && m.text.includes(HOST_MESSAGE))).toBe(true);
    expect(history.some((m) => m.role === 'assistant' && m.text.includes(HOST_REPLY))).toBe(true);
    const done = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: next.body['turnId'], outcome: { kind: 'completed', reply: 'Then we rest.' } });
    expect(done.body['status']).toBe('completed');
  }, RUNTIME_TIMEOUT_MS);

  it('hands the host the donor\'s explicit tool contract for each model call, and the turn completes when the host follows it', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'x-1', sessionId: 'session-x', message: 'Call the orient tool to list my values, then tell me the first one.' });
    expect(prepared.body).toMatchObject({ kind: 'prepared' });
    const turnId = prepared.body['turnId'] as string;
    // The first model call must be exactly one orient call, as the donor's provider client forced it.
    expect((prepared.body['context'] as { toolChoice: unknown }).toolChoice).toEqual({ kind: 'tool', name: 'orient' });
    const choice = (hostInstance: string, id: string) => bridge(w, 'tool-choice', operator, { hostInstance, turnId: id });
    expect((await choice('hermes-1', turnId)).body).toEqual({ toolChoice: { kind: 'tool', name: 'orient' } });
    expect((await choice('hermes-9', turnId)).status).toBe(403);
    expect((await bridge(w, 'tool-choice', w.credentials['hermes-friend'], { hostInstance: 'hermes-1', turnId })).status).toBe(404);

    const client = await mcpClient(w, operator);
    try {
      const called = await client.callTool({ name: 'orient', arguments: { action: 'values_list' } });
      expect(called.isError ?? false).toBe(false);
    } finally {
      await client.close();
    }
    // The sequence ran: the next model call must not call a tool (the donor's 'none').
    expect((await choice('hermes-1', turnId)).body).toEqual({ toolChoice: { kind: 'none' } });
    const settled = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId, outcome: { kind: 'completed', reply: 'Your first value is curiosity.' } });
    expect(settled.body).toMatchObject({ turnId, status: 'completed' });
    expect((await choice('hermes-1', turnId)).status).toBe(404);
  }, RUNTIME_TIMEOUT_MS);

  it('records an interrupted and a failed host turn as the donor ends them, and refuses tools outside an open turn', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const friend = w.credentials['hermes-friend'];

    const client = await mcpClient(w, operator);
    try {
      const outside = await client.callTool({ name: 'orient', arguments: { action: 'values_list' } });
      expect(outside.isError).toBe(true);
      expect(JSON.stringify(outside.structuredContent)).toContain('no_open_turn');
    } finally {
      await client.close();
    }

    const first = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'i-1', sessionId: 'session-b', message: 'Wait, never mind.' });
    expect(first.body['kind']).toBe('prepared');
    // One agent: another principal's turn waits for this one.
    const busy = await bridge(w, 'prepare', friend, { hostInstance: 'hermes-2', hermesInstallId: INSTALL, idempotencyKey: 'f-1', sessionId: 'session-f', message: 'Hi!' });
    expect(busy.status).toBe(503);
    const sameAgain = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'i-2', sessionId: 'session-b', message: 'Another.' });
    expect(sameAgain.status).toBe(409);
    const interrupted = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: first.body['turnId'], outcome: { kind: 'interrupted' } });
    expect(interrupted.body).toMatchObject({ status: 'interrupted' });

    const second = await bridge(w, 'prepare', friend, { hostInstance: 'hermes-2', hermesInstallId: INSTALL, idempotencyKey: 'f-1', sessionId: 'session-f', message: 'Hi!' });
    expect(second.body['kind']).toBe('prepared');
    const notOwner = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: second.body['turnId'], outcome: { kind: 'completed', reply: 'x' } });
    expect(notOwner.status).toBe(403);
    const failed = await bridge(w, 'settle', friend, { hostInstance: 'hermes-2', turnId: second.body['turnId'], outcome: { kind: 'failed', error: { code: 'host_model_error', message: 'the host model failed' } } });
    expect(failed.body).toMatchObject({ status: 'failed', reply: null });
    const checkpoint = await bridge(w, 'checkpoint', friend, { hermesInstallId: INSTALL, sessionId: 'session-f', turnIds: [second.body['turnId']] });
    expect(checkpoint.body).toEqual({ settled: [second.body['turnId']], open: [] });
  }, RUNTIME_TIMEOUT_MS);

  it('binds the bridge to its Hermes install and signs the install\'s journals with the scoped keyring', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    // Another Hermes install is refused: its sessions are not this companion's.
    const foreign = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-9', hermesInstallId: OTHER_INSTALL, idempotencyKey: 'x-1', sessionId: 'session-x', message: 'Hi.' });
    expect(foreign.status).toBe(403);
    expect(foreign.body['error']).toMatchObject({ kind: 'denied', reason: 'wrong_install' });
    const foreignCheckpoint = await bridge(w, 'checkpoint', operator, { hermesInstallId: OTHER_INSTALL, sessionId: 'session-a', turnIds: [] });
    expect(foreignCheckpoint.status).toBe(403);
    // The operator's own (non-Hermes) turn and a Hermes turn, both written by the runtime.
    await w.runtime.converse('A note from the terminal.');
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 'j-1', sessionId: 'session-j', message: 'Remember the journal.' });
    expect(prepared.body['kind']).toBe('prepared');
    const settled = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Noted.' } });
    expect(settled.body['status']).toBe('completed');

    const keyring = createSessionHmacBoundaryService({ env: { ...w.install.env } }).requireKeyring('the test install has a session keyring');
    const bound = createHostSessionIntegrityProvider(keyring, INSTALL);
    const otherInstall = createHostSessionIntegrityProvider(keyring, OTHER_INSTALL);
    const plain = createHostSessionIntegrityProvider(keyring, null);
    const all = [...journals(w.install.dataDir).values()];
    const hermes = all.filter((entries) => entries.some((entry) => entry.channelId.startsWith('api:hermes:')));
    const own = all.filter((entries) => entries.some((entry) => entry.channelId.startsWith('terminal:')));
    expect(hermes.length).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(0);
    for (const entries of [...hermes, ...own]) {
      // The chain is on: every entry the runtime wrote carries the donor HMAC and verifies under the host's provider.
      expect(entries.every((entry) => typeof entry._hmac === 'string' && entry._hmacKeyVersion === keyring.activeVersion)).toBe(true);
      expect(chainVerifies(bound, entries)).toBe(true);
    }
    for (const entries of hermes) {
      // Bound to the install: neither another install's keyring nor the plain env keyring verifies it.
      expect(chainVerifies(otherInstall, entries)).toBe(false);
      expect(chainVerifies(plain, entries)).toBe(false);
      // Tampering with a recorded message is detected.
      const index = entries.findIndex((entry) => entry.type === 'message' && typeof entry.content === 'string');
      expect(index).toBeGreaterThanOrEqual(0);
      const tampered = entries.map((entry, i) => (i === index ? { ...entry, content: `${entry.content ?? ''} (edited)` } : entry));
      expect(chainVerifies(bound, tampered)).toBe(false);
    }
    // The operator's own conversation keeps the donor env-keyring chain, whichever install is bound.
    for (const entries of own) expect(chainVerifies(plain, entries) && chainVerifies(otherInstall, entries)).toBe(true);
  }, RUNTIME_TIMEOUT_MS);

  it('fails a host turn the host leaves open past its timeout', async () => {
    const w = world();
    const operator = w.credentials['hermes-operator'];
    const prepared = await bridge(w, 'prepare', operator, { hostInstance: 'hermes-1', hermesInstallId: INSTALL, idempotencyKey: 't-1', sessionId: 'session-t', message: 'Are you there?' });
    expect(prepared.body['kind']).toBe('prepared');
    await new Promise((resolve) => setTimeout(resolve, HOST_TURN_TIMEOUT_MS + 1_500));
    const late = await bridge(w, 'settle', operator, { hostInstance: 'hermes-1', turnId: prepared.body['turnId'], outcome: { kind: 'completed', reply: 'Yes.' } });
    expect(late.body).toMatchObject({ status: 'failed' });
  }, RUNTIME_TIMEOUT_MS);
});
