import { describe, expect, it } from 'vitest';
import {
  TOOL_INVENTORY,
  createToolDispatcher,
  deriveWorkerScope,
  internalContext,
  notFound,
  ok,
  type ActionHandler,
  type ActionHandlers,
  type TrustedTurnScope,
} from '../../packages/core/src/index.ts';
import { FRIEND, directAttestation, id, standardWorld } from './fakes.ts';

/** Records the authority each handler was invoked with. */
function recordingHandler(seen: TrustedTurnScope[]): ActionHandler {
  return (scope, args) => {
    seen.push(scope);
    return Promise.resolve(ok({ echoed: args }));
  };
}

function dispatcherWith(handlers: ActionHandlers) {
  const created = createToolDispatcher({ inventory: TOOL_INVENTORY, handlers });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return created.value;
}

describe('domain action dispatch', () => {
  it('passes ingress authority to the handler; model arguments cannot replace it', async () => {
    const seen: TrustedTurnScope[] = [];
    const dispatcher = dispatcherWith({ contact: { lookup: recordingHandler(seen) } });
    const { admit } = standardWorld();
    const scope = await admit('friend-dm');

    const result = await dispatcher.dispatch(scope, { tool: 'contact', action: 'lookup', args: { contactId: 'contact-primary' } });
    expect(result.ok && result.value).toEqual({
      origin: { kind: 'tool_result', tool: 'contact', action: 'lookup' },
      content: { echoed: { contactId: 'contact-primary' } },
    });
    expect(seen[0]?.caller).toEqual({ kind: 'participant', contactId: FRIEND, trust: 'trusted' });

    const smuggled = await dispatcher.dispatch(scope, {
      tool: 'contact',
      action: 'lookup',
      args: { viewer: { trust: 'primary' }, contactId: 'contact-primary' },
    });
    expect(smuggled.ok || smuggled.error.kind).toBe('invalid');
    expect(seen).toHaveLength(1);
  });

  it('fails closed on forged scopes, unknown tools/actions, bad arguments and missing handlers', async () => {
    const dispatcher = dispatcherWith({});
    const scope = await standardWorld().admit('primary-dm');
    const cases = [
      dispatcher.dispatch({ ...scope }, { tool: 'memory', action: 'search', args: {} }),
      dispatcher.dispatch(scope, { tool: 'wiki', action: 'read', args: {} }),
      dispatcher.dispatch(scope, { tool: 'memory', action: 'delete', args: {} }),
      dispatcher.dispatch(scope, { tool: 'memory', action: 'search', args: ['q'] }),
      dispatcher.dispatch(scope, { tool: 'memory', action: 'search', args: undefined }),
      dispatcher.dispatch(scope, { tool: 'memory', action: 'search', args: {} }),
    ];
    const kinds = (await Promise.all(cases)).map((r) => (r.ok ? 'ok' : r.error.kind));
    expect(kinds).toEqual(['denied', 'invalid', 'invalid', 'invalid', 'invalid', 'unavailable']);
  });

  it('refuses to build with a handler for an action that is not in the inventory', () => {
    const created = createToolDispatcher({
      inventory: TOOL_INVENTORY,
      handlers: { memory: { redact: () => Promise.resolve(ok(null)) } },
    });
    expect(created.ok || created.error).toEqual({ kind: 'invalid', issues: ['handler memory.redact is not in the inventory'] });
  });

  it('enforces admission, foreground-only and self-audience restrictions declared in the inventory', async () => {
    const seen: TrustedTurnScope[] = [];
    const handler = recordingHandler(seen);
    const dispatcher = dispatcherWith({
      values: { list_values: handler },
      session: { new: handler },
      free_time: { rest: handler },
    });
    const world = standardWorld();
    world.contacts.byIdentity.set('chat:acquaintance', { kind: 'known', contactId: id('contact-acq'), trust: 'public' });
    world.authenticator.tokens.set('acq-dm', directAttestation('acquaintance', 'dm-acq'));

    const lowTrust = await dispatcher.dispatch(await world.admit('acq-dm'), { tool: 'values', action: 'list_values', args: {} });
    expect(lowTrust.ok || lowTrust.error).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });

    const background = await dispatcher.dispatch(await world.admit('friend-dm-background'), { tool: 'session', action: 'new', args: {} });
    expect(background.ok || background.error).toMatchObject({ kind: 'denied', reason: 'background_turn' });

    const restInDm = await dispatcher.dispatch(await world.admit('primary-dm'), { tool: 'free_time', action: 'rest', args: {} });
    expect(restInDm.ok || restInDm.error).toMatchObject({ kind: 'denied', reason: 'requires_self_audience' });

    const restInFreeTime = await dispatcher.dispatch(await world.admit('free-time'), { tool: 'free_time', action: 'rest', args: {} });
    expect(restInFreeTime.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('limits workers to their grant and to actions open to workers', async () => {
    const seen: TrustedTurnScope[] = [];
    const handler = recordingHandler(seen);
    const dispatcher = dispatcherWith({ memory: { search: handler, get: handler }, contact: { lookup: handler } });
    const parent = await standardWorld().admit('primary-dm');
    const worker = deriveWorkerScope(parent, id('run-1'), {
      actions: [
        { tool: 'memory', action: 'search' },
        { tool: 'contact', action: 'lookup' },
      ],
      maxTurns: 4,
    });
    if (!worker.ok) throw new Error('worker scope');

    expect((await dispatcher.dispatch(worker.value, { tool: 'memory', action: 'search', args: {} })).ok).toBe(true);
    const ungranted = await dispatcher.dispatch(worker.value, { tool: 'memory', action: 'get', args: {} });
    expect(ungranted.ok || ungranted.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    const closed = await dispatcher.dispatch(worker.value, { tool: 'contact', action: 'lookup', args: {} });
    expect(closed.ok || closed.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
    expect(seen.map((s) => s.caller.kind)).toEqual(['worker']);

    const nested = deriveWorkerScope(worker.value, id('run-2'), { actions: [], maxTurns: 1 });
    expect(nested.ok || nested.error).toMatchObject({ kind: 'denied', reason: 'worker_not_permitted' });
  });

  it('returns domain failures unchanged and attributes results as tool output, never speech', async () => {
    const dispatcher = dispatcherWith({
      memory: { get: () => Promise.resolve(notFound('memory m-1')), search: () => Promise.resolve(ok(['a memory'])) },
    });
    const scope = await standardWorld().admit('primary-dm');
    const missing = await dispatcher.dispatch(scope, { tool: 'memory', action: 'get', args: { id: 'm-1' } });
    expect(missing.ok || missing.error).toEqual({ kind: 'not_found', subject: 'memory m-1' });

    const found = await dispatcher.dispatch(scope, { tool: 'memory', action: 'search', args: { query: 'x' } });
    if (!found.ok) throw new Error('search');
    const entry = internalContext(found.value.origin, JSON.stringify(found.value.content));
    expect(entry.ok && entry.value).toMatchObject({ role: 'labelled_context', label: 'tool result: memory.search' });
  });
});
