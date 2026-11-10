/**
 * The conversation transport on the real standalone runtime over PostgreSQL:
 * a turn sent over HTTP is a donor-driven turn of the operator's own
 * conversation (the channel `chat` and `once` use), so a host's turns and the
 * operator's terminal turns share one history, and what the companion sends
 * on her own reaches the event stream.
 */
import { describe, expect, it } from 'vitest';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { RUNTIME_TIMEOUT_MS, newCredential, useLiteWorld } from '../support/lite-world.ts';

const TOKEN_ENV = 'LITE_TEST_CONVERSATION_TOKEN';

describe.skipIf(dockerTestsOptedOut('conversation transport'))('conversation transport on the companion', () => {
  const lite = useLiteWorld();

  it('carries the operator\'s turns into the one conversation the terminal uses', async () => {
    const credential = newCredential();
    const install = await lite.install((document) => {
      document.conversation = {
        host: '127.0.0.1',
        port: 0,
        allowedHosts: null,
        maxBodyBytes: 65_536,
        outboxCapacity: 16,
        bindings: [{ principal: 'voice-host', credential: { env: TOKEN_ENV }, contact: 'operator' }],
      };
    });
    install.env[TOKEN_ENV] = credential;
    const { runtime, model } = await lite.start(install, (call) => {
      if (call.lastUser.includes('MARK-VOICE')) return 'A heron, standing very still.';
      if (call.lastUser.includes('MARK-TERMINAL')) return 'You saw a heron.';
      return null;
    });
    const url = runtime.transports.conversationUrl;
    if (url === null) throw new Error('the conversation transport was not mounted');
    const post = (path: string, body: unknown, token = credential) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

    expect((await post('/turns', { message: 'hello' }, newCredential())).status).toBe(401);
    const spoken = await post('/turns', { message: 'MARK-VOICE I saw a heron by the canal this morning.' });
    expect(spoken.status).toBe(200);
    expect(await spoken.json()).toEqual({ reply: 'A heron, standing very still.', channelId: 'terminal:robin' });

    // The terminal's next turn is assembled from the turn the host carried.
    const typed = await runtime.converse('MARK-TERMINAL What did I see this morning?');
    expect(typed.content).toBe('You saw a heron.');
    expect(typed.channelId).toBe('terminal:robin');
    const seen = JSON.stringify(model.calls.find((call) => call.lastUser.includes('MARK-TERMINAL'))?.context.messages ?? []);
    expect(seen).toContain('I saw a heron by the canal this morning.');
    expect(seen).toContain('A heron, standing very still.');
  }, RUNTIME_TIMEOUT_MS);
});
