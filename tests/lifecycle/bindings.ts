/** Principal bindings a Hermes host is configured with in the bridge and Hermes end-to-end tests. */

/** The operator on the Hermes surface in its own direct conversation, and a regular friend on another channel. */
export const HERMES_BINDINGS = {
  'hermes-operator': {
    surface: 'hermes',
    principal: { kind: 'channel_account', identity: { channelKind: 'cli', externalId: 'operator-1' } },
    room: { kind: 'direct', channelId: 'hermes-direct' },
    turnKind: 'foreground',
  },
  'hermes-friend': {
    surface: 'hermes',
    principal: { kind: 'channel_account', identity: { channelKind: 'telegram', externalId: 'friend-1' } },
    room: { kind: 'direct', channelId: 'friend-direct' },
    turnKind: 'foreground',
  },
} as const;
