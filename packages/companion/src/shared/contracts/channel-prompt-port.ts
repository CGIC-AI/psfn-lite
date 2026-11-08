// ── Channel prompt-dock port ──
//
// Lite extraction (seam 3.12, channels cut). The substrate agent reads channel
// prompt facets (prompt channel type, task kind, reaction surface) through an
// optional registry it defaults to an empty `Map` (substrate-agent.ts
// `channelRegistry: ChannelPromptRegistryPort = new Map()`), and its
// handleMessage takes the in-process turn-control options. The channel
// adapters, the registry implementation and the backplane are not core: with
// no docks registered, resolveChannelPromptDock returns undefined and every
// turn takes the donor's dock-less path.
//
// Declarations copied verbatim from the donor at e6a9546:
// src/channels/backplane/types.ts (MessageHandlerOptions 14-29,
// ChannelChatType 35, ChannelCapabilities 42-49, ChannelPromptAdapter 127-138,
// ChannelPromptDock 186-190) and src/channels/backplane/registry-port.ts
// (ChannelPromptRegistryPort 3-5).
import type { SubstrateMessage } from './runtime.js';
import type { ResolvedReactionSurface } from './reaction-surface.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';
import type { PrecomputedNoReplyDisposition } from '../../core/participation/types.js';

/**
 * mmo9.6.1: in-process turn-control options threaded alongside a dispatched
 * message. `cancellationId` is the transport-agnostic turn identity (also
 * carried on {@link SubstrateMessage.routing} for serialized hops); `signal`
 * is a non-serializable AbortSignal that, when aborted, cancels the specific
 * in-flight turn it was dispatched with. Both are optional and additive: a
 * handler that ignores them behaves exactly as before.
 */
export interface MessageHandlerOptions {
  signal?: AbortSignal;
  cancellationId?: string;
  /** Authenticated scope already consumed by pre-dispatch intake screening. */
  conversationScope?: ConversationScope;
  /** Trusted local appraisal result; accepted only by authenticated inbound ICP turns. */
  precomputedNoReplyDisposition?: PrecomputedNoReplyDisposition;
}

export type ChannelChatType = 'direct' | 'channel' | 'thread';

export interface ChannelCapabilities {
  chatTypes: readonly ChannelChatType[];
  media: boolean;
  reactions: boolean;
  threads: boolean;
  streaming: boolean;
  promptChannelType?: string;
}

export interface ChannelPromptAdapter {
  resolveChannelType(message: SubstrateMessage): string | undefined;
  resolveTaskKind?(message: SubstrateMessage): string | undefined;
  /**
   * jp36.3.1.2: curated emoji reaction surface advertised to the companion for
   * this turn — the standard subset plus any guild-custom emojis carrying a
   * configured one-line meaning (unknown custom emojis excluded). Optional and
   * gated by {@link ChannelCapabilities.reactions}; a channel that cannot
   * resolve a surface returns undefined and the prompt block renders nothing.
   */
  listAvailableReactions?(message: SubstrateMessage): ResolvedReactionSurface | undefined;
}

export interface ChannelPromptDock {
  id: string;
  capabilities: Pick<ChannelCapabilities, 'promptChannelType'>;
  prompt?: Pick<ChannelPromptAdapter, 'resolveChannelType' | 'resolveTaskKind' | 'listAvailableReactions'>;
}

export interface ChannelPromptRegistryPort {
  get(id: string): ChannelPromptDock | undefined;
}
