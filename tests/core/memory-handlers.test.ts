import { describe, expect, it } from 'vitest';
import {
  SENSITIVITIES,
  TOOL_INVENTORY,
  audienceDisclosureClass,
  canViewerRead,
  conversationKey,
  sourceAccessFor,
  sourceReadable,
  type Audience,
  type Sensitivity,
} from '../../packages/core/src/index.ts';
import { id } from './fakes.ts';
import { fakeMemoryWorld, kindOf } from './memory-world.ts';

const WIRED = ['memory', 'episode', 'journal'];

describe('memory, episode and journal tools are wired into dispatch', () => {
  it('reaches a handler for every inventoried action from a participant and a self turn', async () => {
    const world = await fakeMemoryWorld();
    const scopes = [await world.admit('primary-dm'), await world.admit('reflection')];
    const tools = TOOL_INVENTORY.filter((t) => WIRED.includes(t.name));
    expect(tools.map((t) => t.domain).sort()).toEqual(['episodes', 'journals', 'memory']);
    expect(tools.flatMap((t) => t.actions).length).toBe(30);
    for (const scope of scopes) {
      for (const tool of tools) {
        for (const action of tool.actions) {
          const result = await world.call(scope, tool.name, action.name, {});
          expect(kindOf(result), `${tool.name}.${action.name}`).not.toBe('unavailable');
        }
      }
    }
  });

  it('rejects authority-shaped and unknown arguments before any domain work', async () => {
    const world = await fakeMemoryWorld();
    const scope = await world.admit('friend-dm');
    const subject = await world.call(scope, 'memory', 'write', {
      writeId: 'w1',
      kind: 'fact',
      content: 'Sam likes tea',
      sensitivity: 'personal',
      subjectContactIds: ['someone-else'],
    });
    expect(subject.ok || subject.error).toEqual({ kind: 'invalid', issues: ['unknown arguments: subjectContactIds'] });
    const viewer = await world.call(scope, 'memory', 'search', { query: 'tea', viewer: { kind: 'self' } });
    expect(kindOf(viewer)).toBe('invalid');
    expect(world.memories.records.size).toBe(0);
  });
});

describe('source access is canViewerRead as data', () => {
  const audiences: Audience[] = [
    { kind: 'self' },
    { kind: 'direct', channelId: id('dm-1'), contactId: id('c-1') },
    { kind: 'direct', channelId: id('dm-2'), contactId: id('c-2') },
    { kind: 'group', channelId: id('room-1'), room: 'small_group' },
    { kind: 'group', channelId: id('room-2'), room: 'large_group' },
    { kind: 'group', channelId: id('room-3'), room: 'broadcast' },
  ];
  const admissions: Sensitivity[][] = [[], ['public'], ['public', 'personal'], [...SENSITIVITIES]];

  it('agrees with canViewerRead for every viewer, admission, worker flag and source', () => {
    let checked = 0;
    for (const viewerAudience of audiences) {
      for (const admitted of admissions) {
        for (const worker of [false, true]) {
          const viewer = { audience: viewerAudience, admitted, worker };
          const access = sourceAccessFor(viewer, null);
          for (const source of audiences) {
            const expected = canViewerRead(viewer, source);
            expect(sourceReadable(access, conversationKey(source), audienceDisclosureClass(source)), JSON.stringify({ viewer, source })).toBe(expected);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(audiences.length * admissions.length * 2 * audiences.length);
  });
});
