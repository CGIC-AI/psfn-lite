import { isOneOf, isRecord, deepFreeze } from './guards.ts';
import type { ChannelId, ContactId } from './ids.ts';
import { invalid, ok, type Result } from './result.ts';

export const SENSITIVITIES = ['public', 'personal', 'intimate', 'confidential'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** Trust held by a known, tracked contact. Unknown trust is not a level; it rejects. */
export const TRUST_LEVELS = ['public', 'regular', 'trusted', 'primary'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** How widely a conversation's content can travel. Ordered narrowest first. */
export const ROOM_KINDS = ['direct', 'small_group', 'large_group', 'broadcast'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/**
 * Who can observe the current turn. `self` is a companion-internal turn with
 * no participant present (reflection, free time, maintenance).
 */
export type Audience =
  | { readonly kind: 'self' }
  | { readonly kind: 'direct'; readonly channelId: ChannelId; readonly contactId: ContactId }
  | { readonly kind: 'group'; readonly channelId: ChannelId; readonly room: Exclude<RoomKind, 'direct'> };

/**
 * Owner-versioned disclosure configuration: the sensitivities a caller of each
 * trust level may be shown in each kind of room. Supplied explicitly to ingress.
 */
export interface DisclosurePolicy {
  readonly version: number;
  readonly ceilings: Readonly<Record<TrustLevel, Readonly<Record<RoomKind, readonly Sensitivity[]>>>>;
}

/**
 * Baseline derived from the donor trust ceiling: trusted and regular share
 * public+personal, only primary sees intimate/confidential and only in a
 * direct room, and wider rooms never admit more than narrower ones.
 */
export const BASELINE_DISCLOSURE_POLICY: DisclosurePolicy = deepFreeze({
  version: 1,
  ceilings: {
    public: { direct: ['public'], small_group: ['public'], large_group: ['public'], broadcast: ['public'] },
    regular: { direct: ['public', 'personal'], small_group: ['public'], large_group: ['public'], broadcast: ['public'] },
    trusted: {
      direct: ['public', 'personal'],
      small_group: ['public', 'personal'],
      large_group: ['public'],
      broadcast: ['public'],
    },
    primary: {
      direct: ['public', 'personal', 'intimate', 'confidential'],
      small_group: ['public', 'personal'],
      large_group: ['public'],
      broadcast: ['public'],
    },
  },
});

/** Validates owner configuration. Any unknown or widening entry rejects. */
export function parseDisclosurePolicy(raw: unknown): Result<DisclosurePolicy> {
  if (!isRecord(raw)) return invalid('disclosure policy must be an object');
  const { version, ceilings } = raw;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return invalid('disclosure policy version must be a positive integer');
  }
  if (!isRecord(ceilings)) return invalid('disclosure policy ceilings must be an object');
  const issues: string[] = [];
  for (const key of Object.keys(ceilings)) {
    if (!isOneOf(TRUST_LEVELS, key)) issues.push(`unknown trust level ${key}`);
  }
  const parsed: Partial<Record<TrustLevel, Record<RoomKind, readonly Sensitivity[]>>> = {};
  for (const trust of TRUST_LEVELS) {
    const rooms = ceilings[trust];
    if (!isRecord(rooms)) {
      issues.push(`missing ceilings for trust ${trust}`);
      continue;
    }
    const byRoom: Partial<Record<RoomKind, readonly Sensitivity[]>> = {};
    for (const key of Object.keys(rooms)) {
      if (!isOneOf(ROOM_KINDS, key)) issues.push(`unknown room kind ${trust}.${key}`);
    }
    for (const room of ROOM_KINDS) {
      const list = rooms[room];
      if (!Array.isArray(list) || !list.every((s) => isOneOf(SENSITIVITIES, s))) {
        issues.push(`ceiling ${trust}.${room} must list known sensitivities`);
        continue;
      }
      if (new Set(list).size !== list.length) issues.push(`ceiling ${trust}.${room} has duplicates`);
      byRoom[room] = list;
    }
    issues.push(...wideningIssues(trust, byRoom));
    parsed[trust] = byRoom as Record<RoomKind, readonly Sensitivity[]>;
  }
  if (issues.length > 0) return invalid(...issues);
  return ok(deepFreeze({ version, ceilings: parsed as DisclosurePolicy['ceilings'] }));
}

function wideningIssues(trust: TrustLevel, byRoom: Partial<Record<RoomKind, readonly Sensitivity[]>>): string[] {
  const issues: string[] = [];
  for (let i = 1; i < ROOM_KINDS.length; i += 1) {
    const narrower = ROOM_KINDS[i - 1];
    const wider = ROOM_KINDS[i];
    if (narrower === undefined || wider === undefined) continue;
    const narrowList = byRoom[narrower];
    const wideList = byRoom[wider];
    if (narrowList === undefined || wideList === undefined) continue;
    for (const s of wideList) {
      if (!narrowList.includes(s)) issues.push(`ceiling ${trust}.${wider} admits ${s} beyond ${trust}.${narrower}`);
    }
  }
  return issues;
}

/** The sensitivities in `admitted` that are no more sensitive than `ceiling`. */
export function capSensitivities(admitted: readonly Sensitivity[], ceiling: Sensitivity): readonly Sensitivity[] {
  const limit = SENSITIVITIES.indexOf(ceiling);
  return admitted.filter((s) => SENSITIVITIES.indexOf(s) <= limit);
}

/** Rank of a sensitivity, lowest first. */
export function sensitivityRank(sensitivity: Sensitivity): number {
  return SENSITIVITIES.indexOf(sensitivity);
}

/**
 * The sensitivity class of material produced in an audience, derived from the
 * donor's channel classification (`src/core/session/search-runtime.ts`): a
 * private (direct) room is confidential, an invite-only small group personal,
 * and large groups and broadcasts public. Companion-internal material is
 * confidential. Another audience may read such material only when its own
 * admission includes this class.
 */
export function audienceDisclosureClass(audience: Audience): Sensitivity {
  switch (audience.kind) {
    case 'self':
    case 'direct':
      return 'confidential';
    case 'group':
      return audience.room === 'small_group' ? 'personal' : 'public';
  }
}

/** Stable key of the conversation an audience belongs to. */
export function conversationKey(audience: Audience): string {
  return audience.kind === 'self' ? 'self' : `channel:${audience.channelId}`;
}

/** Whether two audiences are the same conversation (same room). */
export function sameConversation(a: Audience, b: Audience): boolean {
  return conversationKey(a) === conversationKey(b);
}

/** Structural equality of audiences, including the direct contact. */
export function sameAudience(a: Audience, b: Audience): boolean {
  if (a.kind === 'self' || b.kind === 'self') return a.kind === b.kind;
  if (a.kind === 'direct' && b.kind === 'direct') return a.channelId === b.channelId && a.contactId === b.contactId;
  if (a.kind === 'group' && b.kind === 'group') return a.channelId === b.channelId && a.room === b.room;
  return false;
}

/** Channel privacy labels a host may record as evidence; they never gate disclosure. */
export const CHANNEL_PRIVACY_LEVELS = ['private', 'invite_only', 'public'] as const;
export type ChannelPrivacy = (typeof CHANNEL_PRIVACY_LEVELS)[number];

/** Who is reading: the turn's audience and admission, and whether a bounded worker reads for it. */
export interface Viewer {
  readonly audience: Audience;
  readonly admitted: readonly Sensitivity[];
  readonly worker: boolean;
}

/**
 * Whether a viewer may read material produced in `source`. Companion-internal
 * material stays with self turns. A principal always reads its own
 * conversation, and companion turns read every participant conversation;
 * otherwise, and always for workers, the viewer's admission must include the
 * source's disclosure class.
 */
export function canViewerRead(viewer: Viewer, source: Audience): boolean {
  const sourceClass = audienceDisclosureClass(source);
  if (source.kind === 'self') {
    return viewer.audience.kind === 'self' && (!viewer.worker || viewer.admitted.includes(sourceClass));
  }
  if (!viewer.worker && (viewer.audience.kind === 'self' || sameConversation(viewer.audience, source))) return true;
  return viewer.admitted.includes(sourceClass);
}
