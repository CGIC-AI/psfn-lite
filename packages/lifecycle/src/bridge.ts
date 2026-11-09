/**
 * The host-driven turn use cases the lifecycle bridge serves: prepare,
 * settle and checkpoint a host's turn, and run the host's tool calls inside
 * it. Identity comes from the transport credential only: the bound principal
 * names one contact the host provisioned, and the bridge builds the donor's
 * `SubstrateMessage` from it. The conversation is the donor's own Hermes
 * channel convention (`externalMemorySessionId`: `api:hermes:<digest of
 * companion, principal, contact and the host's session id>`), a direct
 * message on the `api` channel type with the contact as the canonical
 * contact hint (donor runtime-context.ts resolveAuthorContext).
 *
 * The bridge serves one Hermes install (docs/extraction.md, Step E2): a
 * Hermes install is one source serving one user through its desktop,
 * gateway, mobile, messaging and CLI surfaces, and its sessions are bound to
 * it. Prepare and checkpoint name the install; another install is refused.
 * The session journals of its conversations are signed with a keyring scoped
 * to that install (apps/standalone/src/session-integrity.ts).
 */
import { createHash } from 'node:crypto';
import { conflict, denied, invalid, notFound, ok, unavailable, type Result } from './mcp.ts';
import type { ToolCallOutput } from './mcp.ts';
import { createTurnId, externalMemorySessionId, type SubstrateMessage, type TurnRecord } from './companion.ts';
import type { HostToolChoice, HostTurn, HostTurnAgent, HostTurnContext, HostTurnEnd, HostTurnRelay } from './host-turns.ts';

/** The contact a principal speaks as, provisioned by the host in the companion's contact store. */
export interface BoundContact {
  readonly contactId: string;
  readonly displayName: string;
}

export interface HostTurnBridgeOptions {
  readonly relay: HostTurnRelay;
  readonly agent: HostTurnAgent;
  readonly companionId: string;
  /** The one Hermes install this bridge serves (its install id). */
  readonly hermesInstallId: string;
  readonly contactOf: (principal: string) => BoundContact | null;
  /** The donor's recorded turn for a conversation, for checkpoints (SessionManager.findUniqueSourceRecordedTurn). */
  readonly findRecordedTurn: (channelId: string, turnId: string) => Promise<TurnRecord | null>;
  /** A host-driven turn the host neither settles nor continues within this time is failed (`host_turn_timeout`). */
  readonly maxOpenMs: number;
  /** How many ended turns are remembered so a repeated settle answers the same. */
  readonly endedMemory?: number;
  readonly onTimeout?: (turnId: string) => void;
}

export interface PrepareInput {
  readonly hostInstance: string;
  readonly hermesInstallId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly message: string;
}

export type PrepareAnswer =
  | { readonly kind: 'prepared'; readonly turnId: string; readonly resumed: boolean; readonly context: HostTurnContext }
  /** The donor already recorded this key's turn (its source-message dedupe). */
  | { readonly kind: 'replayed' }
  /** The donor's turn ended without asking the host's model (for example a no-reply decision). */
  | { readonly kind: 'answered'; readonly turnId: string; readonly reply: string };

export type HostOutcome =
  | { readonly kind: 'completed'; readonly reply: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'failed'; readonly code: string };

export interface SettleInput {
  readonly hostInstance: string;
  readonly turnId: string;
  readonly outcome: HostOutcome;
}

export interface SettleAnswer {
  readonly turnId: string;
  /** What the donor recorded: its final response, or that the turn failed or was interrupted. */
  readonly status: 'completed' | 'failed' | 'interrupted';
  /** The donor's response text (the reply as recorded, after the donor's own reply handling). */
  readonly reply: string | null;
}

export interface CheckpointAnswer {
  readonly settled: readonly string[];
  readonly open: readonly string[];
}

const MAX_KEY_CHARS = 256;

export class HostTurnBridge {
  private readonly ended = new Map<string, { owner: string; answer: SettleAnswer }>();
  private readonly options: HostTurnBridgeOptions;

  constructor(options: HostTurnBridgeOptions) {
    this.options = options;
  }

  private channelOf(principal: string, contact: BoundContact, sessionId: string): string {
    return externalMemorySessionId({ bodyId: principal, companionId: this.options.companionId, contactId: contact.contactId }, sessionId);
  }

  /** The donor message id: stable for one principal and key, so a re-prepare finds the same turn and the donor's dedupe sees it. */
  private requestIdOf(principal: string, key: string): string {
    return `host:${createHash('sha256').update(JSON.stringify([principal, key])).digest('hex').slice(0, 48)}`;
  }

  private ownedBy(principal: string, turn: HostTurn): boolean {
    return turn.owner.startsWith(`${principal}/`);
  }

  /** Whether a request names the Hermes install this bridge serves. */
  boundInstall(hermesInstallId: string): Result<null> {
    return hermesInstallId === this.options.hermesInstallId
      ? ok(null)
      : denied('wrong_install', 'this companion is bound to another Hermes install');
  }

  async prepare(principal: string, input: PrepareInput): Promise<Result<PrepareAnswer>> {
    const contact = this.options.contactOf(principal);
    if (contact === null) return denied('unknown_authority', 'the principal is not bound to a contact');
    const bound = this.boundInstall(input.hermesInstallId);
    if (!bound.ok) return bound;
    if (input.idempotencyKey.length > MAX_KEY_CHARS) return invalid('idempotencyKey is too long');
    const channelId = this.channelOf(principal, contact, input.sessionId);
    const requestId = this.requestIdOf(principal, input.idempotencyKey);
    const owner = `${principal}/${input.hostInstance}`;
    const existing = this.options.relay.get(requestId);
    if (existing !== undefined) {
      // The host lost the answer and asks again: the same turn, still waiting for it.
      return ok({ kind: 'prepared', turnId: existing.turnId, resumed: true, context: existing.context });
    }
    if (this.options.relay.hasRecorded(channelId, requestId)) return ok({ kind: 'replayed' });
    const open = this.options.relay.open();
    if (open.some((turn) => this.ownedBy(principal, turn))) return conflict('turn_already_open', 'this principal already has an open turn');
    // One companion, one agent: the donor runs one foreground turn at a time.
    if (open.length > 0) return unavailable('companion_turn', 'another host-driven turn is open');
    const message: SubstrateMessage = {
      id: requestId,
      channelId,
      channelType: 'api',
      authorId: principal,
      authorName: contact.displayName,
      content: input.message,
      timestamp: new Date(),
      isDirectMessage: true,
      routing: { turnId: createTurnId(), canonicalContactId: contact.contactId },
    };
    let outcome;
    try {
      outcome = await this.options.relay.begin(message, owner);
    } catch (error) {
      return unavailable('companion_turn', error instanceof Error ? error.message : 'the turn could not start');
    }
    if (outcome.kind === 'ended') {
      const answer = this.remember(owner, outcome.turnId, outcome.end, false);
      if (outcome.end.kind === 'error') return unavailable('companion_turn', outcome.end.error.message);
      return ok({ kind: 'answered', turnId: outcome.turnId, reply: answer.reply ?? '' });
    }
    const turn = outcome.turn;
    this.armTimeout(turn);
    void turn.end().then((end) => this.remember(turn.owner, turn.turnId, end, turn.wasInterrupted));
    return ok({ kind: 'prepared', turnId: turn.turnId, resumed: false, context: turn.context });
  }

  private armTimeout(turn: HostTurn): void {
    const timer = setTimeout(() => {
      if (turn.isEnded) return;
      this.options.onTimeout?.(turn.turnId);
      void turn.fail('host_turn_timeout');
    }, this.options.maxOpenMs);
    timer.unref();
    void turn.end().finally(() => clearTimeout(timer));
  }

  private remember(owner: string, turnId: string, end: HostTurnEnd, interrupted: boolean): SettleAnswer {
    const known = this.ended.get(turnId);
    if (known !== undefined) return known.answer;
    const answer: SettleAnswer = end.kind === 'response'
      ? { turnId, status: interrupted ? 'interrupted' : 'completed', reply: end.response.content }
      : { turnId, status: interrupted ? 'interrupted' : 'failed', reply: null };
    this.ended.set(turnId, { owner, answer });
    const limit = this.options.endedMemory ?? 1024;
    while (this.ended.size > limit) {
      const oldest = this.ended.keys().next().value;
      if (oldest === undefined) break;
      this.ended.delete(oldest);
    }
    return answer;
  }

  async settle(principal: string, input: SettleInput): Promise<Result<SettleAnswer>> {
    const owner = `${principal}/${input.hostInstance}`;
    const turn = this.options.relay.open().find((candidate) => candidate.turnId === input.turnId);
    if (turn === undefined) {
      const known = this.ended.get(input.turnId);
      if (known === undefined || !known.owner.startsWith(`${principal}/`)) return notFound('turn');
      return ok(known.answer);
    }
    if (turn.owner !== owner) return denied('not_turn_owner', 'only the host instance that prepared the turn settles it');
    const outcome = input.outcome;
    const end = await (outcome.kind === 'completed'
      ? turn.complete(outcome.reply)
      : outcome.kind === 'interrupted'
        ? turn.interrupt(this.options.agent)
        : turn.fail(outcome.code));
    return ok(this.remember(owner, turn.turnId, end, turn.wasInterrupted));
  }

  /** Which of the session's turns the donor recorded (settled) and which are still open. */
  async checkpoint(principal: string, hermesInstallId: string, sessionId: string, turnIds: readonly string[]): Promise<Result<CheckpointAnswer>> {
    const contact = this.options.contactOf(principal);
    if (contact === null) return denied('unknown_authority', 'the principal is not bound to a contact');
    const bound = this.boundInstall(hermesInstallId);
    if (!bound.ok) return bound;
    const channelId = this.channelOf(principal, contact, sessionId);
    const settled: string[] = [];
    const open: string[] = [];
    for (const turnId of turnIds) {
      const live = this.options.relay.open().find((turn) => turn.turnId === turnId);
      if (live !== undefined) {
        if (!this.ownedBy(principal, live)) return notFound('turn');
        open.push(turnId);
        continue;
      }
      const record = await this.options.findRecordedTurn(channelId, turnId);
      if (record === null) return notFound('turn');
      settled.push(turnId);
    }
    return ok({ settled, open });
  }

  /**
   * The donor's tool choice for the model call the host answers next in its
   * open turn: the explicit tool contract the donor's provider client forced
   * with tool_choice, which the host applies to its own model. Only the host
   * instance that prepared the turn asks; an ended turn is not found.
   */
  async toolChoice(principal: string, hostInstance: string, turnId: string): Promise<Result<{ readonly toolChoice: HostToolChoice }>> {
    const turn = this.options.relay.open().find((candidate) => candidate.turnId === turnId);
    if (turn === undefined || !this.ownedBy(principal, turn)) return notFound('turn');
    if (turn.owner !== `${principal}/${hostInstance}`) return denied('not_turn_owner', 'only the host instance that prepared the turn asks for its tool choice');
    return ok({ toolChoice: await turn.toolChoice() });
  }

  /** A host tool call, run by the donor's loop as the model's tool call of the principal's open turn. */
  async callTool(principal: string, name: string, args: Readonly<Record<string, unknown>>): Promise<Result<ToolCallOutput>> {
    const turn = this.options.relay.open().find((candidate) => this.ownedBy(principal, candidate));
    if (turn === undefined) return denied('no_open_turn', 'companion tools run only inside an open host-driven turn of this principal');
    const result = await turn.callTool(name, { ...args });
    if (result.kind === 'turn_ended') return conflict('turn_ended', 'the companion turn ended before the call ran');
    return ok({ text: result.text, isError: result.isError });
  }
}
