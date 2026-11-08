/**
 * Operator bindings for the standard cast of the core test worlds, plus
 * deliberately bad ones. Plain data: shared by the in-process world and the
 * stdio server process, which cannot load the test runner.
 */
import type { HostAttestation } from '../../packages/core/src/index.ts';

const SURFACE = 'mcp';

const direct = (externalId: string, channel: string, turnKind: 'foreground' | 'background' = 'foreground'): HostAttestation =>
  ({
    surface: SURFACE,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'direct', channelId: channel },
    turnKind,
  }) as unknown as HostAttestation;

/** Operator bindings for the standard cast, plus deliberately bad ones. */
export const BINDINGS = {
  primary: direct('primary-handle', 'dm-primary'),
  friend: direct('friend-handle', 'dm-friend'),
  'friend-background': direct('friend-handle', 'dm-friend', 'background'),
  acquaintance: direct('acq-handle', 'dm-acq'),
  stranger: direct('stranger-handle', 'dm-stranger'),
  'friend-group': {
    surface: SURFACE,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'friend-handle' } },
    room: { kind: 'group', channelId: 'room-a', room: 'small_group' },
    turnKind: 'foreground',
  },
  self: { surface: SURFACE, principal: { kind: 'companion_internal', purpose: 'free_time' }, room: { kind: 'self' }, turnKind: 'background' },
  // Bound, but to nobody core knows.
  nobody: direct('nobody-handle', 'dm-nobody'),
  // A participant claiming the companion's own room.
  'self-claim': { surface: SURFACE, principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId: 'primary-handle' } }, room: { kind: 'self' }, turnKind: 'foreground' },
} as const;
