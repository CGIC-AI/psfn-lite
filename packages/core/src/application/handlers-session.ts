import { CONTINUITY_OCCASIONS } from '../sessions/index.ts';
import { LIMIT, withArgs } from './arguments.ts';
import type { ActionHandler } from './dispatch.ts';
import type { SessionService } from './session-service.ts';

/** `session` tool actions over the session service. */
export function sessionHandlers(sessions: SessionService): Readonly<Record<string, ActionHandler>> {
  return {
    list: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => sessions.list(scope, input)),
    search: (scope, args) =>
      withArgs(
        args,
        ['query', 'sessionId', 'limit', 'summarize'],
        (a) => ({
          query: a.string('query'),
          sessionId: a.optionalId('session', 'sessionId'),
          limit: a.integer('limit', LIMIT),
          summarize: a.boolean('summarize', false),
        }),
        (input) => sessions.search(scope, input),
      ),
    grep: (scope, args) =>
      withArgs(
        args,
        ['pattern', 'caseSensitive', 'sessionId', 'limit'],
        (a) => ({
          pattern: a.string('pattern'),
          caseSensitive: a.boolean('caseSensitive', false),
          sessionId: a.optionalId('session', 'sessionId'),
          limit: a.integer('limit', LIMIT),
        }),
        (input) => sessions.grep(scope, input),
      ),
    messages: (scope, args) =>
      withArgs(
        args,
        ['sessionId', 'limit'],
        (a) => ({ sessionId: a.optionalId('session', 'sessionId'), limit: a.integer('limit', LIMIT) }),
        (input) => sessions.messages(scope, input),
      ),
    continuity_list: (scope, args) =>
      withArgs(
        args,
        ['sessionId', 'limit'],
        (a) => ({ sessionId: a.optionalId('session', 'sessionId'), limit: a.integer('limit', LIMIT) }),
        (input) => sessions.continuityList(scope, input),
      ),
    new: (scope, args) => withArgs(args, [], () => null, () => sessions.startNew(scope)),
    resume: (scope, args) =>
      withArgs(args, ['sessionId'], (a) => ({ sessionId: a.id('session', 'sessionId') }), (input) => sessions.resume(scope, input)),
    wake_return: (scope, args) =>
      withArgs(
        args,
        ['sessionId', 'summary', 'occasion', 'nextAnchor'],
        (a) => ({
          sessionId: a.optionalId('session', 'sessionId'),
          summary: a.string('summary'),
          occasion: a.oneOf('occasion', CONTINUITY_OCCASIONS),
          nextAnchor: a.optionalString('nextAnchor'),
        }),
        (input) => sessions.wakeReturn(scope, input),
      ),
    start_focus: (scope, args) =>
      withArgs(
        args,
        ['sessionId', 'focus'],
        (a) => ({ sessionId: a.optionalId('session', 'sessionId'), focus: a.string('focus') }),
        (input) => sessions.startFocus(scope, input),
      ),
    complete_focus: (scope, args) =>
      withArgs(
        args,
        ['sessionId', 'knowledge'],
        (a) => ({ sessionId: a.optionalId('session', 'sessionId'), knowledge: a.optionalString('knowledge') }),
        (input) => sessions.completeFocus(scope, input),
      ),
  };
}
