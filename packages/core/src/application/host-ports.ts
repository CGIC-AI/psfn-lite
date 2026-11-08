import type {
  Author,
  ChannelId,
  PresentationRole,
  Result,
  RoomKind,
  SurfaceId,
  TurnId,
} from '../shared/index.ts';
import type { ChannelIdentity } from '../contacts/index.ts';
import type { CareReminder } from '../intention/index.ts';
import type { InternalPurpose, TrustedTurnScope } from './trusted-scope.ts';

/**
 * Capabilities the host supplies to core. Core owns these interfaces;
 * adapters implement them. Each use case takes only the ports it needs.
 */

/** What the host verified about a request before it reached core. */
export interface HostAttestation {
  readonly surface: SurfaceId;
  readonly principal:
    | { readonly kind: 'channel_account'; readonly identity: ChannelIdentity }
    | { readonly kind: 'companion_internal'; readonly purpose: InternalPurpose };
  readonly room:
    | { readonly kind: 'self' }
    | { readonly kind: 'direct'; readonly channelId: ChannelId }
    | { readonly kind: 'group'; readonly channelId: ChannelId; readonly room: Exclude<RoomKind, 'direct'> };
  readonly turnKind: 'foreground' | 'background';
}

/** Verifies transport evidence (session, token, signature) held by the host. */
export interface CallerAuthenticatorPort {
  authenticate(evidence: unknown): Promise<Result<HostAttestation>>;
}

/** Why a model call is made and whose words its output becomes. */
export interface WorkAttribution {
  readonly purpose: string;
  readonly turnId: TurnId | null;
  /** Only a turn carrying the companion's identity produces companion speech; anything else is inference. */
  readonly output: 'companion_turn' | 'machine_inference';
}

export interface ModelMessage {
  readonly role: PresentationRole;
  readonly label: string | null;
  readonly text: string;
}

export interface ModelPort {
  complete(request: {
    readonly attribution: WorkAttribution;
    readonly messages: readonly ModelMessage[];
    readonly maxOutputTokens: number;
  }): Promise<Result<{ readonly text: string; readonly inputTokens: number; readonly outputTokens: number }>>;
}

export interface EmbeddingPort {
  embed(texts: readonly string[], attribution: WorkAttribution): Promise<Result<readonly (readonly number[])[]>>;
}

/** Host-owned approval queue for proposals core never applies directly. */
export interface ApprovalPort {
  submit(proposal: {
    readonly kind: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requestedBy: Author;
  }): Promise<Result<{ readonly proposalId: string }>>;
}

/**
 * Channel delivery of a due care reminder, owned by the host. Return ok once
 * delivered. Return `denied`, `invalid` or `not_found` only when the message
 * definitely did not go out; the reminder is then tried again on a later
 * tick. Any other failure, `unavailable` in particular (a timeout or a
 * transport error after sending may have begun), is read as "may have
 * landed": the delivery is recorded as unknown and never retried. Core marks
 * the reminder before asking, so a crash in between is not delivered twice
 * either.
 */
export interface ReminderDeliveryPort {
  deliver(reminder: CareReminder): Promise<Result<void>>;
}

/** Why core asks the host for a companion-internal turn, and what it refers to. */
export interface InternalTurnRequest {
  /** A companion-internal scope admitted by ingress for a self audience; the turn's tool calls use it. */
  readonly scope: TrustedTurnScope;
  readonly purpose: InternalPurpose;
  /** The internal trigger shown to the companion, labelled as a system note, never as participant speech. */
  readonly prompt: string;
  readonly reference: { readonly kind: 'free_time_block' | 'scheduled_prompt'; readonly id: string };
}

export interface InternalTurnResult {
  readonly status: 'completed' | 'interrupted' | 'failed';
  /** The companion's own reply in that turn, if any. */
  readonly reply: string | null;
}

/**
 * Runs one companion turn in a self audience through the active harness: the
 * host prepares and settles the turn and runs the model loop with the
 * companion's identity and permitted tools. Every call is model inference.
 */
export interface InternalTurnPort {
  run(request: InternalTurnRequest): Promise<Result<InternalTurnResult>>;
}
