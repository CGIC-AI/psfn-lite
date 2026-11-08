import {
  SENSITIVITIES,
  audienceDisclosureClass,
  conversationKey,
  type Audience,
  type ChannelId,
  type ContactId,
  type Sensitivity,
  type Viewer,
} from '../shared/index.ts';
import type { MemoryRecord, MemorySubject } from './types.ts';

/**
 * Which subjects a viewer may read. Self turns read every subject. A
 * participant (or a worker acting for one) reads only material about
 * themselves or about the room they are in: this is the donor's mandatory
 * subject authorization (`src/faculties/memory/subject-authorized-store.ts`),
 * where an unauthorized subject reads as absent.
 */
export type SubjectAccess =
  | { readonly kind: 'any' }
  | { readonly kind: 'bound'; readonly contactIds: readonly ContactId[]; readonly roomChannelIds: readonly ChannelId[] };

/**
 * `canViewerRead` and the subject rule as plain data, so a store can apply
 * the same filter inside its query, before ranking and limits. That keeps
 * withheld material out of result sets, counts and nearest-neighbour lists
 * instead of trimming it afterwards.
 *
 * - `sensitivities`: a record's own sensitivity must be one of these.
 * - `sourceClasses`: material from any conversation whose disclosure class is
 *   listed is readable.
 * - `ownConversations`: conversations readable regardless of class (a
 *   principal's own room).
 * - `selfSource`: whether companion-internal material is readable.
 */
export interface SourceAccess {
  readonly sensitivities: readonly Sensitivity[];
  readonly sourceClasses: readonly Sensitivity[];
  readonly ownConversations: readonly string[];
  readonly selfSource: boolean;
  readonly subjects: SubjectAccess;
}

/** The access of a viewer; `viewerContactId` is the trusted caller (or a worker's parent caller). */
export function sourceAccessFor(viewer: Viewer, viewerContactId: ContactId | null): SourceAccess {
  const { audience } = viewer;
  if (audience.kind === 'self') {
    return {
      sensitivities: [...viewer.admitted],
      sourceClasses: viewer.worker ? [...viewer.admitted] : [...SENSITIVITIES],
      ownConversations: [],
      selfSource: !viewer.worker || viewer.admitted.includes('confidential'),
      subjects: { kind: 'any' },
    };
  }
  return {
    sensitivities: [...viewer.admitted],
    sourceClasses: [...viewer.admitted],
    ownConversations: viewer.worker ? [] : [conversationKey(audience)],
    selfSource: false,
    subjects: { kind: 'bound', contactIds: viewerContactId === null ? [] : [viewerContactId], roomChannelIds: [audience.channelId] },
  };
}

/** The keys a store records for a source audience: its conversation and disclosure class. */
export function sourceKeys(source: Audience): { readonly conversation: string; readonly sourceClass: Sensitivity } {
  return { conversation: conversationKey(source), sourceClass: audienceDisclosureClass(source) };
}

/** Equivalent to `canViewerRead(viewer, source)` for the viewer the access was derived from. */
export function sourceReadable(access: SourceAccess, conversation: string, sourceClass: Sensitivity): boolean {
  if (conversation === 'self') return access.selfSource;
  return access.ownConversations.includes(conversation) || access.sourceClasses.includes(sourceClass);
}

export function subjectReadable(access: SourceAccess, subject: MemorySubject): boolean {
  if (access.subjects.kind === 'any') return true;
  const bound = access.subjects;
  switch (subject.kind) {
    case 'companion_internal':
      return false;
    case 'room':
      return bound.roomChannelIds.includes(subject.channelId);
    case 'contacts':
      return subject.contactIds.some((c) => bound.contactIds.includes(c));
  }
}

/** Participant rule for episodes: a bound viewer reads episodes it took part in or that happened in its room. */
export function participantsReadable(access: SourceAccess, participants: readonly ContactId[], source: Audience): boolean {
  if (access.subjects.kind === 'any') return true;
  const bound = access.subjects;
  if (source.kind !== 'self' && bound.roomChannelIds.includes(source.channelId)) return true;
  return participants.some((c) => bound.contactIds.includes(c));
}

/** Whether a current memory is visible. Non-current records never are. */
export function memoryReadable(access: SourceAccess, record: MemoryRecord): boolean {
  return memoryReadableInAnyState(access, record) && record.state === 'current';
}

/** Visibility ignoring lifecycle, for `restore` of a soft-deleted memory. */
export function memoryReadableInAnyState(access: SourceAccess, record: MemoryRecord): boolean {
  const { conversation, sourceClass } = sourceKeys(record.provenance.source);
  return (
    access.sensitivities.includes(record.sensitivity) &&
    sourceReadable(access, conversation, sourceClass) &&
    subjectReadable(access, record.subject)
  );
}

/** Stable key of a subject, used to group evolution candidates. */
export function subjectKey(subject: MemorySubject): string {
  switch (subject.kind) {
    case 'companion_internal':
      return 'companion';
    case 'room':
      return `room:${subject.channelId}`;
    case 'contacts':
      return `contacts:${[...subject.contactIds].sort().join(',')}`;
  }
}

export function subjectContacts(subject: MemorySubject): readonly ContactId[] {
  return subject.kind === 'contacts' ? subject.contactIds : [];
}
