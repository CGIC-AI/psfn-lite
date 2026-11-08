import type { Author, ChannelId, Result } from '../shared/index.ts';

/** Orientation blocks, kept per conversation scope. */
export type CoreBlockName = 'persona' | 'human' | 'goals';

/** `conversation:<channel>` scopes; there is no implicit global scope. */
export interface CoreBlockScope {
  readonly kind: 'conversation';
  readonly channelId: ChannelId;
}

export interface CoreBlock {
  readonly name: CoreBlockName;
  readonly scope: CoreBlockScope;
  readonly text: string;
  readonly maxChars: number;
  readonly revision: number;
}

/** Orientation blocks for one scope; writes are compare-and-set on revision. */
export interface CoreBlockPort {
  read(scope: CoreBlockScope): Promise<Result<readonly CoreBlock[]>>;
  write(input: {
    readonly scope: CoreBlockScope;
    readonly name: CoreBlockName;
    readonly text: string;
    readonly expectedRevision: number;
    readonly author: Author;
  }): Promise<Result<CoreBlock>>;
}

/** Prompt layer order, lowest precedence first. Base and operator layers are protected. */
export type LayerType = 'base' | 'operator' | 'system_language' | 'runtime' | 'channel' | 'task';

export interface PromptLayer {
  readonly id: string;
  readonly type: LayerType;
  readonly version: number;
  readonly checksum: string;
  readonly enabled: boolean;
  readonly content: string;
}

/** A change to a protected layer, queued for operator approval with stale checks. */
export interface LayerChangeProposal {
  readonly layerId: string;
  readonly change: 'update' | 'rollback' | 'toggle';
  readonly previousVersion: number;
  readonly previousChecksum: string;
  readonly proposedContent?: string;
  readonly proposedEnabled?: boolean;
  readonly reason: string;
}

/** A companion-authored value. Revisions append a new version; nothing is edited in place. */
export interface ValueEntry {
  readonly id: string;
  readonly version: number;
  readonly reflection: string;
  readonly author: Author;
  readonly derivedFromVersion: number | null;
  readonly createdAt: string;
}

export interface ValuesJournalPort {
  list(limit: number): Promise<Result<readonly ValueEntry[]>>;
  append(entry: ValueEntry): Promise<Result<ValueEntry>>;
}

/** At most three ordered long-horizon guiding intentions. */
export const MAX_NORTH_STAR_ITEMS = 3;

export interface NorthStarItem {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly version: number;
}
