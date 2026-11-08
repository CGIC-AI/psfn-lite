/**
 * The standalone runtime end to end: the real CLI entry and composition over
 * a throwaway Postgres, the JSONL archive in temporary roots, and pi-ai's
 * faux provider as the model. Covers scoped prepare -> execute -> record ->
 * post-turn, free-time reflection and rest, attributable failure and
 * interruption, and a stop/reset/restart that keeps the companion's history,
 * memory, emotion, rest and reflections.
 */
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmotionReading, FreeTimeLaneStatus } from '../../packages/core/src/index.ts';
import { dockerTestsOptedOut } from '../support/postgres-harness.ts';
import { callTool, providerError, say, withDefaults, type BrainCall } from '../pi/faux-brain.ts';
import { archived, emptyDirectory, must, operatorScope, selfScope, unwrap, useStandalone } from './standalone-world.ts';

const MINUTE = 60_000;
const REPO = join(import.meta.dirname, '..', '..');

/** The companion's script across both process lifetimes. */
function companion(call: BrainCall) {
  const invitation = /Free time is open[\s\S]*blockId (\S+)\)/.exec(call.lastUser);
  if (invitation !== null) {
    if (call.afterTool) return say('Done choosing.');
    // The first block is for reflection; once the self session has history, the companion rests.
    return callTool('free_time', 'choose', { blockId: invitation[1], optionId: call.context.messages.length > 1 ? 'rest' : 'reflect' });
  }
  if (call.lastUser.includes('Your free time (block')) return say('The bees were loud this morning; I liked thinking about them.');
  if (call.lastUser.includes('I keep bees')) {
    return call.afterTool ? say('I will remember the bees.') : callTool('memory', 'write', { writeId: 'bees-1', kind: 'fact', content: 'Robin keeps bees on the roof garden.', sensitivity: 'personal' });
  }
  if (call.lastUser.includes('what do you remember')) {
    return call.afterTool ? say(`From memory: ${call.toolResults[0] ?? ''}`) : callTool('memory', 'search', { query: 'bees roof garden' });
  }
  return say(`ok (${String(call.context.messages.length)} in view)`);
}

describe.skipIf(dockerTestsOptedOut('standalone'))('the standalone runtime over Postgres', () => {
  const lite = useStandalone();

  it('runs the CLI: init registers the operator once, and once runs one scoped, recorded, observed turn', async () => {
    const install = await lite.install();
    const host = lite.fauxHost(install, withDefaults(companion), 'cli-1');

    const before = await lite.cli(install, ['once', '--config', install.configPath, '--text', 'hello'], host.factory);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('refused: ');

    const init = await lite.cli(install, ['init', '--config', install.configPath], host.factory);
    expect(init).toMatchObject({ code: 0, stderr: '' });
    expect(init.stdout).toMatch(/^registered operator contact /);
    const again = await lite.cli(install, ['init', '--config', install.configPath], host.factory);
    expect(again.stdout).toMatch(/^already registered operator contact /);

    const once = await lite.cli(install, ['once', '--config', install.configPath, '--text', 'hello there', '--key', 'cli-k1', '--json'], host.factory);
    expect(once.stderr).toBe('');
    expect(once.code).toBe(0);
    const summary = JSON.parse(once.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: 'completed',
      reply: 'ok (1 in view)',
      delivery: 'delivered',
      outcome: { kind: 'completed', reply: 'ok (1 in view)', delivery: 'delivered' },
      usage: { modelCalls: 1, toolCalls: 0 },
      postTurn: { emotion: { ok: true, status: 'observed' }, workers: { ok: true, resumed: [] } },
    });
    expect(host.replies).toEqual(['ok (1 in view)']);
    // Prepare ran under the operator's scope: the companion saw its system prompt and only the trigger.
    const turn = host.model.calls.find((c) => c.kind === 'companion');
    expect(turn?.lastUser).toBe('[participant speech]\nhello there');
    expect(turn?.systemPrompt).toContain('You are the companion');
    // Post-turn emotion observation went through the estimator and the appraisal model.
    expect(host.model.calls.map((c) => c.kind)).toEqual(expect.arrayContaining(['estimator']));

    // The same key replays from the ledger: no model call, the recorded reply.
    const calls = host.model.calls.length;
    const replay = await lite.cli(install, ['once', '--config', install.configPath, '--text', 'hello there', '--key', 'cli-k1', '--json'], host.factory);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ status: 'replayed', reply: 'ok (1 in view)' });
    expect(host.model.calls.length).toBe(calls);

    // The canonical history is the JSONL archive.
    const { runtime } = await lite.start(install, withDefaults(companion), 'inspect');
    const session = unwrap(await runtime.stacks.sessions.current(await operatorScope(runtime)));
    expect(await archived(runtime, session.sessionId)).toEqual([
      { origin: 'participant_speech', text: 'hello there' },
      { origin: 'companion_speech', text: 'ok (1 in view)' },
    ]);
  });

  it('records a failed turn and an interrupted chat turn with their causes, and the conversation goes on', async () => {
    const install = await lite.install();
    let interrupt: () => void = () => undefined;
    const brain = withDefaults((call) => {
      if (call.lastUser.endsWith('please fail')) return providerError('provider overloaded');
      if (call.lastUser.endsWith('tell me a long story')) {
        setTimeout(() => interrupt(), 30);
        return say('Once upon a time '.repeat(300));
      }
      return companion(call);
    });
    const host = lite.fauxHost(install, brain, 'chat-1', { tokensPerSecond: 2_000 });
    expect((await lite.cli(install, ['init', '--config', install.configPath], host.factory)).code).toBe(0);

    const failed = await lite.cli(install, ['once', '--config', install.configPath, '--text', 'please fail', '--json'], host.factory);
    expect(failed.code).toBe(3);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed', outcome: { kind: 'failed', error: { code: 'model_error', message: 'provider overloaded' } } });

    async function* lines() {
      yield 'tell me a long story';
      yield 'are you there?';
    }
    const chat = await lite.cli(install, ['chat', '--config', install.configPath], host.factory, {
      lines,
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {
          interrupt = () => undefined;
        };
      },
    });
    expect(chat.code).toBe(0);
    expect(chat.stderr).toContain('[turn interrupted]');
    expect(chat.stdout).not.toContain('Once upon a time');

    const { runtime } = await lite.start(install, brain, 'inspect');
    const session = unwrap(await runtime.stacks.sessions.current(await operatorScope(runtime)));
    const entries = await archived(runtime, session.sessionId);
    expect(entries.map((e) => e.origin)).toEqual([
      'participant_speech',
      'system_note',
      'participant_speech',
      'companion_speech',
      'system_note',
      'participant_speech',
      'companion_speech',
    ]);
    expect(entries[1]?.text).toBe('turn failed: model_error: provider overloaded');
    expect(entries[3]?.text.startsWith('Once upon a time')).toBe(true);
    expect(entries[4]?.text).toBe('turn interrupted by participant');
    // The turn after the interruption saw the partial reply and the note as context.
    const after = host.model.calls.find((c) => c.kind === 'companion' && c.lastUser.includes('are you there?'));
    // The participant's next words follow the lifecycle note as their own labelled block, never as part of the note.
    expect(after?.lastUser).toBe('[system note: turn_lifecycle]\nturn interrupted by participant\n\n[participant speech]\nare you there?');
    expect(after?.context.messages.at(-2)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: entries[3]?.text }] });
  });

  it('keeps history, memory, emotion, rest and reflections across a stop, a harness reset and a restart', async () => {
    const install = await lite.install();
    let thinking: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      thinking = resolve;
    });
    const brainA = withDefaults((call) => {
      if (!call.lastUser.endsWith('one more long thought')) return companion(call);
      thinking();
      return say('Let me think about that slowly. '.repeat(300));
    });
    const first = await lite.start(install, brainA, 'process-a', { tokensPerSecond: 2_000 });
    const a = first.runtime;
    expect(unwrap(await a.ensureOperator()).created).toBe(true);

    // Free time at midday: the companion reflects; three hours later it rests.
    const reflected = unwrap(await a.tick());
    expect(reflected.scheduler.ok && reflected.scheduler.value.freeTime.find((r) => r.ok && r.value.kind === 'ran')).toBeTruthy();
    install.clock.advance(181 * MINUTE);
    const rested = unwrap(await a.tick());
    expect(rested.scheduler.ok).toBe(true);

    // A conversation with a memory write, observed for emotion.
    const told = unwrap(await a.converse({ text: 'I keep bees on the roof garden', idempotencyKey: 'a-1' }));
    expect(told).toMatchObject({ status: 'completed', reply: 'I will remember the bees.', usage: { toolCalls: 1, failedToolCalls: 0 } });
    const recalled = unwrap(await a.converse({ text: 'what do you remember about my garden?', idempotencyKey: 'a-2' }));
    expect(recalled.reply).toContain('Robin keeps bees on the roof garden.');
    expect(recalled.postTurn?.emotion).toMatchObject({ ok: true, value: { status: 'observed' } });

    const operator = await operatorScope(a);
    const self = await selfScope(a);
    const before = {
      history: await archived(a, told.record.sessionId),
      memory: await must<{ memories: { id: string; content: string }[] }>(a, operator, 'memory', 'search', { query: 'bees roof garden' }),
      emotion: await must<EmotionReading>(a, operator, 'emotion', 'read'),
      freeTime: await must<FreeTimeLaneStatus[]>(a, self, 'free_time', 'status'),
      reflections: await must<{ text: string }[]>(a, self, 'journal', 'reflections_list', { limit: 5 }),
    };
    expect(before.memory.memories.map((m) => m.content)).toEqual(['Robin keeps bees on the roof garden.']);
    expect(before.reflections.map((r) => r.text)).toEqual(['The bees were loud this morning; I liked thinking about them.']);
    const idle = before.freeTime.find((s) => s.lane === 'idle');
    expect(idle?.rest).toMatchObject({ madeBy: 'companion', active: true, decision: { kind: 'companion_rested' } });
    expect(idle?.recent.map((b) => b.state)).toEqual(['rested', 'completed']);

    // Stop mid-turn: shutdown interrupts the running turn and records it before storage closes.
    const slow = a.converse({ text: 'one more long thought', idempotencyKey: 'a-3' });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopping = lite.stop(a);
    const cut = unwrap(await slow);
    await stopping;
    expect(cut.record.settlement?.outcome).toMatchObject({ kind: 'interrupted', by: 'shutdown' });
    expect((await a.converse({ text: 'too late', idempotencyKey: 'a-4' })).ok).toBe(false);

    // Harness reset: nothing outside durable state survives; the workspace is emptied.
    await emptyDirectory(install.roots.workspace);
    await writeFile(join(install.roots.workspace, '.keep'), '');

    const second = await lite.start(install, withDefaults(companion), 'process-b');
    const b = second.runtime;
    expect(unwrap(await b.ensureOperator()).created).toBe(false);
    const operatorB = await operatorScope(b);
    const selfB = await selfScope(b);
    const history = await archived(b, told.record.sessionId);
    expect(history.slice(0, before.history.length)).toEqual(before.history);
    expect(history.slice(before.history.length)).toMatchObject([
      { origin: 'participant_speech', text: 'one more long thought' },
      { origin: 'companion_speech', text: expect.stringMatching(/^Let me think about that slowly\./) as unknown },
      { origin: 'system_note', text: 'turn interrupted by shutdown' },
    ]);
    expect(await must(b, operatorB, 'memory', 'search', { query: 'bees roof garden' })).toEqual(before.memory);
    // Emotion carries on from A's last observation, which was of the turn the shutdown interrupted.
    expect(before.emotion.selfModel?.turnId).toBe(recalled.record.turnId);
    const emotionB = await must<EmotionReading>(b, operatorB, 'emotion', 'read');
    expect(emotionB).toMatchObject({ scope: before.emotion.scope, estimate: { source: 'machine_inference', producer: 'pi:faux/faux-1' }, selfModel: { turnId: cut.record.turnId } });
    const idleB = (await must<FreeTimeLaneStatus[]>(b, selfB, 'free_time', 'status')).find((s) => s.lane === 'idle');
    expect({ rest: idleB?.rest, recent: idleB?.recent }).toEqual({ rest: idle?.rest, recent: idle?.recent });
    expect(await must(b, selfB, 'journal', 'reflections_list', { limit: 5 })).toEqual(before.reflections);

    // The restarted harness continues the conversation from canonical history, not from any Pi session.
    const resumed = unwrap(await b.converse({ text: 'hello again', idempotencyKey: 'b-1' }));
    expect(resumed.status).toBe('completed');
    const seen = second.model.calls.find((c) => c.kind === 'companion' && c.lastUser.includes('hello again'));
    const shown = JSON.stringify(seen?.context.messages);
    expect(shown).toContain('I keep bees on the roof garden');
    expect(shown).toContain('turn interrupted by shutdown');
    // The rest the companion chose before the restart still holds: no new free-time block opens.
    const tick = unwrap(await b.tick());
    expect(tick.scheduler.ok && tick.scheduler.value.freeTime.some((r) => r.ok && r.value.kind === 'ran')).toBe(false);
  });

  it('runs the real process entry: init over Postgres, and a missing secret is named, never shown', async () => {
    const install = await lite.install();
    const document = { ...install.document, model: { provider: 'openai', modelId: 'gpt-4', apiKeyEnv: 'LITE_TEST_MODEL_KEY', maxOutputTokens: 256 } };
    const configPath = join(install.roots.base, 'process.json');
    await writeFile(configPath, JSON.stringify(document));
    const run = (args: readonly string[], env: Record<string, string>) =>
      spawnSync(join(REPO, 'node_modules', '.bin', 'tsx'), [join(REPO, 'apps', 'standalone', 'src', 'main.ts'), ...args], {
        cwd: REPO,
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', ...env },
        timeout: 60_000,
      });

    const missing = run(['once', '--config', configPath, '--text', 'hi'], { ...install.env });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('environment variable LITE_TEST_MODEL_KEY is not set');
    expect(missing.stderr).not.toContain(install.databaseUrl);

    // init needs no model call; the key is a placeholder that is never sent anywhere.
    const init = run(['init', '--config', configPath], { ...install.env, LITE_TEST_MODEL_KEY: 'placeholder-never-sent' });
    expect(init.stderr).toBe('');
    expect(init.status).toBe(0);
    expect(init.stdout).toMatch(/^registered operator contact /);
    const again = run(['init', '--config', configPath], { ...install.env, LITE_TEST_MODEL_KEY: 'placeholder-never-sent' });
    expect(again.stdout).toMatch(/^already registered operator contact /);
  });
});
