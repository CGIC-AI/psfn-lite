import { CONCERN_PRIORITIES, CONCERN_TRANSITION_TARGETS } from '../intention/index.ts';
import { SENSITIVITIES } from '../shared/index.ts';
import { LIMIT, withArgs } from './arguments.ts';
import type { ConcernService } from './concern-service.ts';
import type { ActionHandler, ActionHandlers } from './dispatch.ts';
import type { EmotionService } from './emotion-service.ts';
import type { FollowUpService } from './follow-up-service.ts';

const REVISION = { min: 1, max: 1_000_000 } as const;

/**
 * Handlers for the `emotion` and `concern` tools, keyed as the inventory names
 * them. Hosts merge this with `createContinuityHandlers` before building the
 * dispatcher. `concern.reminder_create` has no handler: there is no reminder
 * store, so dispatch reports it as unavailable.
 */
export function createSelfStateHandlers(services: {
  readonly emotion: EmotionService;
  readonly concerns: ConcernService;
  readonly followUps: FollowUpService;
}): ActionHandlers {
  return { emotion: emotionHandlers(services.emotion), concern: concernHandlers(services.concerns, services.followUps) };
}

function emotionHandlers(emotion: EmotionService): Readonly<Record<string, ActionHandler>> {
  return {
    read: (scope, args) => withArgs(args, [], () => null, () => emotion.read(scope)),
    appraisals: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => emotion.appraisals(scope, input)),
    self_report: (scope, args) =>
      withArgs(args, ['text', 'supersedes'], (a) => ({ text: a.string('text'), supersedes: a.optionalString('supersedes') }), (input) =>
        emotion.selfReport(scope, input),
      ),
  };
}

function concernHandlers(concerns: ConcernService, followUps: FollowUpService): Readonly<Record<string, ActionHandler>> {
  return {
    list: (scope, args) =>
      withArgs(args, ['includeClosed', 'limit'], (a) => ({ includeClosed: a.boolean('includeClosed', false), limit: a.integer('limit', LIMIT) }), (input) =>
        concerns.list(scope, input),
      ),
    create: (scope, args) =>
      withArgs(
        args,
        ['text', 'priority', 'sensitivity', 'evidenceRefs', 'nextReviewAt'],
        (a) => ({
          text: a.string('text'),
          priority: a.oneOf('priority', CONCERN_PRIORITIES, 'medium'),
          sensitivity: a.optionalOneOf('sensitivity', SENSITIVITIES),
          evidenceRefs: args['evidenceRefs'],
          nextReviewAt: a.optionalString('nextReviewAt'),
        }),
        (input) => concerns.create(scope, input),
      ),
    resolve: (scope, args) =>
      withArgs(
        args,
        ['concernId', 'expectedRevision', 'outcome', 'evidenceRefs'],
        (a) => ({
          concernId: a.string('concernId'),
          to: 'resolved' as const,
          expectedRevision: a.integer('expectedRevision', REVISION),
          outcome: a.optionalString('outcome'),
          evidenceRefs: args['evidenceRefs'],
          nextReviewAt: null,
        }),
        (input) => concerns.transition(scope, input),
      ),
    transition: (scope, args) =>
      withArgs(
        args,
        ['concernId', 'to', 'expectedRevision', 'outcome', 'evidenceRefs', 'nextReviewAt'],
        (a) => ({
          concernId: a.string('concernId'),
          to: a.oneOf('to', CONCERN_TRANSITION_TARGETS),
          expectedRevision: a.integer('expectedRevision', REVISION),
          outcome: a.optionalString('outcome'),
          evidenceRefs: args['evidenceRefs'],
          nextReviewAt: a.optionalString('nextReviewAt'),
        }),
        (input) => concerns.transition(scope, input),
      ),
    follow_up_list: (scope, args) =>
      withArgs(args, ['includeDone', 'limit'], (a) => ({ includeDone: a.boolean('includeDone', false), limit: a.integer('limit', LIMIT) }), (input) =>
        followUps.list(scope, input),
      ),
    follow_up_create: (scope, args) =>
      withArgs(
        args,
        ['content', 'dueAt', 'channelId', 'concernId'],
        (a) => ({
          content: a.string('content'),
          dueAt: a.string('dueAt'),
          channelId: a.optionalId('channel', 'channelId'),
          concernId: a.optionalString('concernId'),
        }),
        (input) => followUps.create(scope, input),
      ),
    follow_up_activate: (scope, args) =>
      withArgs(
        args,
        ['followUpId', 'expectedRevision'],
        (a) => ({ followUpId: a.string('followUpId'), expectedRevision: a.integer('expectedRevision', REVISION) }),
        (input) => followUps.activate(scope, input),
      ),
  };
}
