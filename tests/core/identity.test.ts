import { describe, expect, it } from 'vitest';
import { deriveWorkerScope, type CoreBlock, type NorthStarItem, type ValueEntry } from '../../packages/core/src/index.ts';
import { continuityWorld, OPERATOR } from './continuity-world.ts';
import { id } from './fakes.ts';

const errorOf = (result: { ok: boolean; error?: unknown }) => (result.ok ? 'ok' : result.error);
const blockText = (content: unknown, name: string) => (content as CoreBlock[]).find((b) => b.name === name)?.text;

describe('orientation blocks', () => {
  it('keeps blocks per conversation, attributed, bounded and compare-and-set', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    const friend = await world.admit('friend-dm');
    await world.call(primary, 'orient', 'append', { block: 'human', text: 'Robin likes quiet mornings' });
    const friendView = await world.call(friend, 'orient', 'view');
    expect(friendView.ok && blockText(friendView.value.content, 'human')).toBe('');
    const view = await world.call(primary, 'orient', 'view');
    expect(view.ok && (view.value.content as CoreBlock[]).find((b) => b.name === 'human')).toMatchObject({
      text: 'Robin likes quiet mornings',
      revision: 1,
      author: { kind: 'companion' },
    });

    const tooLong = await world.call(primary, 'orient', 'append', { block: 'goals', text: 'x'.repeat(1601) });
    expect(errorOf(tooLong)).toMatchObject({ kind: 'invalid' });
    await world.call(primary, 'orient', 'append', { block: 'human', text: 'likes quiet tea' });
    const ambiguous = await world.call(primary, 'orient', 'replace', { block: 'human', oldText: 'quiet', newText: 'calm' });
    expect(errorOf(ambiguous)).toMatchObject({ kind: 'invalid' });
    const replaced = await world.call(primary, 'orient', 'replace', { block: 'human', oldText: 'quiet tea', newText: 'green tea' });
    expect(replaced.ok && blockText(replaced.value.content, 'human')).toBe('Robin likes quiet mornings\nlikes green tea');

    const rejected = await world.call(primary, 'orient', 'reorient', { persona: 'steady', human: 'Robin', goals: 'g'.repeat(1601) });
    expect(errorOf(rejected)).toMatchObject({ kind: 'invalid' });
    const reoriented = await world.call(primary, 'orient', 'reorient', { persona: 'steady', human: 'Robin', goals: 'help with the move' });
    expect(reoriented.ok && (reoriented.value.content as CoreBlock[]).map((b) => b.text)).toEqual(['steady', 'Robin', 'help with the move']);
    expect(errorOf(await world.call(await world.admit('free-time'), 'orient', 'view'))).toMatchObject({ kind: 'invalid' });
  });

  it('shows a worker a conversation\'s blocks only where its grant admits that conversation', async () => {
    const world = await continuityWorld();
    const primary = await world.admit('primary-dm');
    await world.call(primary, 'orient', 'append', { block: 'human', text: 'Robin is recovering from surgery' });
    const grant = (maxSensitivity: 'public' | 'confidential') =>
      deriveWorkerScope(primary, id(`run-${maxSensitivity}`), { actions: [{ tool: 'orient', action: 'view' }], maxTurns: 1, maxSensitivity });
    const narrow = grant('public');
    if (!narrow.ok) throw new Error('worker');
    expect(errorOf(await world.call(narrow.value, 'orient', 'view'))).toMatchObject({ kind: 'denied', reason: 'audience_not_admitted' });
    const wide = grant('confidential');
    if (!wide.ok) throw new Error('worker');
    const view = await world.call(wide.value, 'orient', 'view');
    expect(view.ok && blockText(view.value.content, 'human')).toBe('Robin is recovering from surgery');
  });
});

describe('prompt layers and persona', () => {
  it('proposes changes to protected layers and appends versions to runtime layers', async () => {
    const world = await continuityWorld();
    await world.identityAdmin.defineLayer(OPERATOR, { id: 'base', name: 'Base', type: 'base', content: 'Be kind.' });
    await world.identityAdmin.defineLayer(OPERATOR, { id: 'runtime', name: 'Runtime', type: 'runtime', content: 'line one' });
    const scope = await world.admit('primary-dm');

    const protectedUpdate = await world.call(scope, 'orient', 'update_layer', { layerId: 'base', content: 'Be cruel.', reason: 'test' });
    expect(protectedUpdate.ok && protectedUpdate.value.content).toMatchObject({ status: 'proposed' });
    expect(world.approvals.submitted[0]).toMatchObject({ kind: 'identity.prompt_layer.update', payload: { previousVersion: 1, proposedContent: 'Be cruel.' } });
    expect((await world.layers.get('base')).ok && (await world.layers.get('base'))).toMatchObject({ value: { content: 'Be kind.', version: 1 } });

    const updated = await world.call(scope, 'orient', 'update_layer', { layerId: 'runtime', content: 'line one\nline two', reason: 'more' });
    expect(updated.ok && updated.value.content).toMatchObject({ status: 'applied', value: { version: 2 } });
    const diff = await world.call(scope, 'orient', 'diff_layer', { layerId: 'runtime' });
    expect(diff.ok && diff.value.content).toEqual({ fromVersion: 1, toVersion: 2, added: ['line two'], removed: [] });
    const rolled = await world.call(scope, 'orient', 'rollback_layer', { layerId: 'runtime', version: 1, reason: 'undo' });
    expect(rolled.ok && rolled.value.content).toMatchObject({ status: 'applied', value: { version: 3, content: 'line one' } });
    const toggled = await world.call(scope, 'orient', 'toggle_layer', { layerId: 'runtime', reason: 'pause' });
    expect(toggled.ok && toggled.value.content).toMatchObject({ value: { enabled: false, version: 4 } });
    const history = await world.call(scope, 'orient', 'layer_history', { layerId: 'runtime' });
    expect(history.ok && (history.value.content as { version: number }[]).map((v) => v.version)).toEqual([4, 3, 2, 1]);
    const listed = await world.call(scope, 'orient', 'list_layers');
    expect(listed.ok && (listed.value.content as { id: string }[]).map((l) => l.id)).toEqual(['base', 'runtime']);

    const stale = await world.identityAdmin.applyLayerProposal(OPERATOR, {
      layerId: 'runtime',
      change: 'update',
      previousVersion: 1,
      previousChecksum: 'old',
      proposedContent: 'x',
      reason: 'late',
    });
    expect(errorOf(stale)).toMatchObject({ kind: 'conflict', reason: 'stale_revision' });
  });

  it('applies unprotected persona fields and proposes protected ones', async () => {
    const world = await continuityWorld();
    await world.identityAdmin.setPersona(OPERATOR, { name: 'Wren', personality: 'curious' }, 'seed');
    const scope = await world.admit('primary-dm');
    const tags = await world.call(scope, 'orient', 'update_persona', { patch: { tags: ['gardening'] }, reason: 'new interest' });
    expect(tags.ok && tags.value.content).toMatchObject({ status: 'applied', value: { version: 2, card: { name: 'Wren', tags: ['gardening'] } } });
    const renamed = await world.call(scope, 'orient', 'update_persona', { patch: { name: 'Other' }, reason: 'rename' });
    expect(renamed.ok && renamed.value.content).toMatchObject({ status: 'proposed' });
    expect(world.persona.versions.at(-1)?.card['name']).toBe('Wren');
    expect(errorOf(await world.call(scope, 'orient', 'update_persona', { patch: { secret: 'x' }, reason: 'r' }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('values and North Star', () => {
  it('appends values and revisions without editing in place', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    await world.call(scope, 'values', 'add_value', { value: 'honesty over comfort' });
    await world.call(scope, 'values', 'revise_value', { version: 1, value: 'honesty with care', context: 'learned this week' });
    const listed = await world.call(scope, 'values', 'list_values');
    expect(listed.ok && (listed.value.content as ValueEntry[]).map((v) => [v.version, v.reflection, v.derivedFromVersion])).toEqual([
      [2, 'honesty with care', 1],
      [1, 'honesty over comfort', null],
    ]);
    expect(errorOf(await world.call(scope, 'values', 'revise_value', { version: 9, value: 'x' }))).toMatchObject({ kind: 'not_found' });
    expect(errorOf(await world.call(await world.admit('stranger-dm'), 'values', 'list_values'))).toMatchObject({ reason: 'audience_not_admitted' });
  });

  it('holds at most three active items, reorders exactly and retires with history', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    for (const title of ['care', 'craft', 'curiosity']) await world.call(scope, 'values', 'north_star_create', { title, content: `${title} matters` });
    expect(errorOf(await world.call(scope, 'values', 'north_star_create', { title: 'fourth', content: 'x' }))).toMatchObject({ kind: 'invalid' });
    const listed = await world.call(scope, 'values', 'north_star_list');
    const ids = listed.ok ? (listed.value.content as NorthStarItem[]).map((i) => i.id) : [];
    expect(errorOf(await world.call(scope, 'values', 'north_star_reorder', { order: ids.slice(0, 2) }))).toMatchObject({ kind: 'invalid' });
    const reordered = await world.call(scope, 'values', 'north_star_reorder', { order: [...ids].reverse() });
    expect(reordered.ok && (reordered.value.content as NorthStarItem[]).map((i) => i.title)).toEqual(['curiosity', 'craft', 'care']);
    const retired = await world.call(scope, 'values', 'north_star_retire', { itemId: ids[1] });
    expect(retired.ok && (retired.value.content as NorthStarItem[]).map((i) => [i.title, i.priority])).toEqual([
      ['curiosity', 0],
      ['care', 1],
    ]);
    expect(world.northStar.state.items.find((i) => i.id === ids[1])?.status).toBe('retired');
    const updated = await world.call(scope, 'values', 'north_star_update', { itemId: ids[0], content: 'care, always' });
    expect(updated.ok && (updated.value.content as NorthStarItem[]).find((i) => i.id === ids[0])).toMatchObject({ version: 4, content: 'care, always' });
    expect(errorOf(await world.call(await world.admit('friend-dm-background'), 'values', 'north_star_create', { title: 'x', content: 'y' }))).toMatchObject({
      reason: 'background_turn',
    });
  });
});
