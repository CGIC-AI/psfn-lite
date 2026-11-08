import type { ContactId } from './ids.ts';

/**
 * Where a piece of text came from. Charter section 4 requires these origins to
 * stay distinguishable in storage and in every rendered context.
 */
export type Origin =
  | { readonly kind: 'participant_speech'; readonly speaker: ContactId }
  | { readonly kind: 'companion_speech' }
  | { readonly kind: 'tool_result'; readonly tool: string; readonly action: string }
  | { readonly kind: 'system_note'; readonly source: string }
  | { readonly kind: 'internal_signal'; readonly source: string }
  | { readonly kind: 'machine_inference'; readonly producer: string }
  | { readonly kind: 'authored_reflection' };

export type OriginKind = Origin['kind'];

/** Every origin that is not speech from a conversation participant. */
export type InternalOrigin = Exclude<Origin, { readonly kind: 'participant_speech' }>;

export const ORIGIN_KINDS: readonly OriginKind[] = Object.freeze([
  'participant_speech',
  'companion_speech',
  'tool_result',
  'system_note',
  'internal_signal',
  'machine_inference',
  'authored_reflection',
]);

/**
 * The conversational role a harness may render an origin as. Only participant
 * speech is ever rendered in the participant role; all internal material is
 * rendered as labelled context, never disguised as something a person said.
 */
export type PresentationRole = 'participant' | 'companion' | 'labelled_context';

export function presentationRole(origin: Origin): PresentationRole {
  switch (origin.kind) {
    case 'participant_speech':
      return 'participant';
    case 'companion_speech':
      return 'companion';
    case 'tool_result':
    case 'system_note':
    case 'internal_signal':
    case 'machine_inference':
    case 'authored_reflection':
      return 'labelled_context';
  }
}

/**
 * Who authored a durable record. Machine authorship is inference and is never
 * promoted to companion-authored affect, meaning or reflection.
 */
export type Author =
  | { readonly kind: 'companion' }
  | { readonly kind: 'participant'; readonly contactId: ContactId }
  | { readonly kind: 'machine'; readonly producer: string }
  | { readonly kind: 'operator'; readonly actor: string }
  | { readonly kind: 'system'; readonly source: string };
