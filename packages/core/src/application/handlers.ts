import type { ContactService } from './contact-service.ts';
import type { ActionHandlers } from './dispatch.ts';
import { contactHandlers } from './handlers-contact.ts';
import { orientHandlers, valuesHandlers } from './handlers-identity.ts';
import { sessionHandlers } from './handlers-session.ts';
import type { OrientationService } from './orientation-service.ts';
import type { SessionService } from './session-service.ts';
import type { ValuesService } from './values-service.ts';

/**
 * Handlers for the durable identity, session and contact tools, keyed as the
 * inventory names them. Hosts pass this to `createToolDispatcher`, which
 * rejects any handler for an action the inventory does not declare.
 */
export function createContinuityHandlers(services: {
  readonly sessions: SessionService;
  readonly contacts: ContactService;
  readonly orientation: OrientationService;
  readonly values: ValuesService;
}): ActionHandlers {
  return {
    session: sessionHandlers(services.sessions),
    contact: contactHandlers(services.contacts),
    orient: orientHandlers(services.orientation),
    values: valuesHandlers(services.values),
  };
}
