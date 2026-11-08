/**
 * What the standalone host itself vouches for. The CLI process is the
 * operator's own terminal, so the host attests exactly two kinds of caller:
 * the configured operator in their direct conversation, and the companion's
 * own internal turns. Evidence is an opaque object this process minted;
 * anything else (a copied structure, text from stdin) is unknown authority.
 * Delivery goes to the operator's terminal and nowhere else.
 */
import {
  denied,
  ok,
  parseId,
  type CallerAuthenticatorPort,
  type CareReminder,
  type ChannelId,
  type HostAttestation,
  type InternalPurpose,
  type ReminderDeliveryPort,
  type Result,
  type SurfaceId,
} from './core.ts';
import type { ReplyDeliveryPort } from './harness.ts';

/** Where the operator reads what the companion sends. */
export interface OperatorChannel {
  reply(text: string): Promise<Result<void>>;
  reminder(reminder: CareReminder): Promise<Result<void>>;
}

export interface LocalHost {
  readonly authenticator: CallerAuthenticatorPort;
  operatorEvidence(): object;
  internalEvidence(purpose: InternalPurpose): object;
  readonly replies: ReplyDeliveryPort;
  readonly reminders: ReminderDeliveryPort;
  readonly operatorChannel: ChannelId;
}

export function createLocalHost(input: {
  readonly surface: SurfaceId;
  readonly operator: { readonly channelKind: string; readonly externalId: string; readonly channelId: string };
  readonly channel: OperatorChannel;
}): Result<LocalHost> {
  const channelId = parseId('channel', input.operator.channelId);
  if (!channelId.ok) return channelId;
  const issued = new WeakMap<object, HostAttestation>();
  const mint = (attestation: HostAttestation): object => {
    const evidence = Object.freeze({});
    issued.set(evidence, attestation);
    return evidence;
  };
  const operator: HostAttestation = {
    surface: input.surface,
    principal: { kind: 'channel_account', identity: { channelKind: input.operator.channelKind, externalId: input.operator.externalId } },
    room: { kind: 'direct', channelId: channelId.value },
    turnKind: 'foreground',
  };
  const isOperatorConversation = (target: CareReminder['target']) => target.kind === 'direct' && target.channelId === channelId.value;

  return ok({
    authenticator: {
      authenticate(evidence) {
        const attestation = typeof evidence === 'object' && evidence !== null ? issued.get(evidence) : undefined;
        return Promise.resolve(attestation === undefined ? denied('unknown_authority', 'evidence was not issued by this host') : ok(attestation));
      },
    },
    operatorEvidence: () => mint(operator),
    internalEvidence: (purpose) =>
      mint({ surface: input.surface, principal: { kind: 'companion_internal', purpose }, room: { kind: 'self' }, turnKind: 'background' }),
    replies: {
      deliver(scope, reply) {
        if (scope.audience.kind !== 'direct' || scope.audience.channelId !== channelId.value) {
          return Promise.resolve(denied('audience_not_admitted', 'the standalone host delivers only to the operator conversation'));
        }
        return input.channel.reply(reply);
      },
    },
    reminders: {
      deliver(reminder) {
        if (!isOperatorConversation(reminder.target)) {
          return Promise.resolve(denied('audience_not_admitted', 'the standalone host has no channel for that conversation'));
        }
        return input.channel.reminder(reminder);
      },
    },
    operatorChannel: channelId.value,
  });
}
