/**
 * PSFN Lite conversation transport: donor-driven turns of the primary
 * contact's conversation over HTTP, and the stream of what the companion
 * sends on her own. It holds no turn logic: the host hands it the runtime's
 * conversation port and its outbound log.
 */
export {
  CONVERSATION_PATH,
  MAX_MESSAGE_CHARS,
  startConversationServer,
  type ConversationErrorReport,
  type ConversationPort,
  type ConversationServer,
  type ConversationServerOptions,
} from './http.ts';
export { createConversationOutbox, type ConversationOutbox, type OutboundEvent } from './outbox.ts';
