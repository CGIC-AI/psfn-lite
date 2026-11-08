import type { Author, ChannelId, Result } from '../shared/index.ts';

/** Orientation blocks, kept per conversation scope. */
export const CORE_BLOCK_NAMES = ['persona', 'human', 'goals'] as const;
export type CoreBlockName = (typeof CORE_BLOCK_NAMES)[number];

/** Character limits per block, from the donor's core memory store. */
export const CORE_BLOCK_LIMITS: Readonly<Record<CoreBlockName, number>> = Object.freeze({
  persona: 2400,
  human: 2400,
  goals: 1600,
});

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
  /** 0 for a block that has never been written. */
  readonly revision: number;
  readonly author: Author | null;
  readonly updatedAt: string | null;
}

export interface CoreBlockWrite {
  readonly name: CoreBlockName;
  readonly text: string;
  readonly expectedRevision: number;
}

/**
 * Orientation blocks for one scope. `read` returns all three blocks, unwritten
 * ones at revision 0. `write` applies every change or none, each
 * compare-and-set on its revision.
 */
export interface CoreBlockPort {
  read(scope: CoreBlockScope): Promise<Result<readonly CoreBlock[]>>;
  write(input: {
    readonly scope: CoreBlockScope;
    readonly changes: readonly CoreBlockWrite[];
    readonly author: Author;
    readonly at: string;
  }): Promise<Result<readonly CoreBlock[]>>;
}

/** Prompt layer order, lowest precedence first. Base and operator layers are protected. */
export const LAYER_TYPES = ['base', 'operator', 'system_language', 'runtime', 'channel', 'task'] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export interface PromptLayer {
  readonly id: string;
  readonly name: string;
  readonly type: LayerType;
  readonly version: number;
  readonly checksum: string;
  readonly enabled: boolean;
  readonly content: string;
}

/** One immutable version of a layer. Rollbacks and toggles append versions. */
export interface PromptLayerVersion {
  readonly layerId: string;
  readonly version: number;
  readonly content: string;
  readonly enabled: boolean;
  readonly checksum: string;
  readonly author: Author;
  readonly reason: string;
  readonly at: string;
}

/** Append-only prompt layers; `commit` is compare-and-set on the current version. */
export interface PromptLayerPort {
  list(): Promise<Result<readonly PromptLayer[]>>;
  get(layerId: string): Promise<Result<PromptLayer>>;
  history(layerId: string, limit: number): Promise<Result<readonly PromptLayerVersion[]>>;
  version(layerId: string, version: number): Promise<Result<PromptLayerVersion>>;
  /** Version 1 creates the layer with its name and type; later versions append. */
  commit(
    next: PromptLayerVersion,
    expectedVersion: number,
    create?: { readonly name: string; readonly type: LayerType },
  ): Promise<Result<PromptLayer>>;
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

/** Persona card fields (character card v2 subset). */
export const PERSONA_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'alternate_greetings',
  'visual_description',
  'tags',
  'creator',
] as const;
export type PersonaField = (typeof PERSONA_FIELDS)[number];

/** Fields the companion may not change on its own; a patch touching one becomes a proposal. */
export const PROTECTED_PERSONA_FIELDS: readonly PersonaField[] = Object.freeze([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'alternate_greetings',
  'visual_description',
]);

export type PersonaCard = Readonly<Record<PersonaField, string | readonly string[]>>;

export interface PersonaVersion {
  readonly version: number;
  readonly card: PersonaCard;
  readonly checksum: string;
  readonly author: Author;
  readonly reason: string;
  readonly at: string;
}

/** Versioned persona card; every change appends a version. */
export interface PersonaPort {
  current(): Promise<Result<PersonaVersion | null>>;
  commit(next: PersonaVersion, expectedVersion: number): Promise<Result<PersonaVersion>>;
}

/** A companion-authored value. Revisions append a new version; nothing is edited in place. */
export interface ValueEntry {
  readonly id: string;
  readonly version: number;
  readonly reflection: string;
  readonly context: string | null;
  readonly author: Author;
  readonly derivedFromVersion: number | null;
  readonly createdAt: string;
}

/** Append-only values journal; a version that already exists is a conflict. */
export interface ValuesJournalPort {
  /** Most recent first. */
  list(limit: number): Promise<Result<readonly ValueEntry[]>>;
  get(version: number): Promise<Result<ValueEntry>>;
  latestVersion(): Promise<Result<number>>;
  append(entry: ValueEntry): Promise<Result<ValueEntry>>;
}

/** At most three ordered long-horizon guiding intentions. */
export const MAX_NORTH_STAR_ITEMS = 3;

export interface NorthStarItem {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly version: number;
  readonly status: 'active' | 'retired';
  readonly updatedAt: string;
  readonly updatedBy: Author;
}

export interface NorthStarState {
  readonly items: readonly NorthStarItem[];
  /** 0 before the first write. */
  readonly revision: number;
}

/** The North Star set; `save` is compare-and-set and keeps every prior item version. */
export interface NorthStarPort {
  read(): Promise<Result<NorthStarState>>;
  save(items: readonly NorthStarItem[], expectedRevision: number, reason: string): Promise<Result<NorthStarState>>;
}
