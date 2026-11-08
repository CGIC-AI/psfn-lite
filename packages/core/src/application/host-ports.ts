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
import type { InternalPurpose } from './trusted-scope.ts';

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
