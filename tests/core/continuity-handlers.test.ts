import { describe, expect, it } from 'vitest';
import { TOOL_INVENTORY } from '../../packages/core/src/index.ts';
import { continuityWorld } from './continuity-world.ts';

const WIRED_TOOLS = ['session', 'contact', 'orient', 'values'];

describe('continuity tools are wired into dispatch', () => {
  it('has a handler for every declared identity, session and contact action', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    for (const tool of TOOL_INVENTORY.filter((t) => WIRED_TOOLS.includes(t.name))) {
      for (const action of tool.actions) {
        const result = await world.call(scope, tool.name, action.name, {});
        const kind = result.ok ? 'ok' : result.error.kind;
        expect(kind, `${tool.name}.${action.name}`).not.toBe('unavailable');
      }
    }
    expect(TOOL_INVENTORY.filter((t) => WIRED_TOOLS.includes(t.name)).map((t) => t.domain).sort()).toEqual(['contacts', 'identity', 'identity', 'sessions']);
  });

  it('rejects unknown and malformed arguments before any domain work', async () => {
    const world = await continuityWorld();
    const scope = await world.admit('primary-dm');
    const unknown = await world.call(scope, 'contact', 'list', { limit: 5, everything: true });
    expect(unknown.ok || unknown.error).toEqual({ kind: 'invalid', issues: ['unknown arguments: everything'] });
    const badLimit = await world.call(scope, 'session', 'list', { limit: 0 });
    expect(badLimit.ok || badLimit.error.kind).toBe('invalid');
    const badId = await world.call(scope, 'session', 'messages', { sessionId: '../etc/passwd' });
    expect(badId.ok || badId.error.kind).toBe('invalid');
  });
});
