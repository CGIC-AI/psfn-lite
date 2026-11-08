import { ACTIVITY_STATUSES, type ArtifactRef } from '../activity/index.ts';
import { SENSITIVITIES, isRecord } from '../shared/index.ts';
import type { ActivityService } from './activity.ts';
import { LIMIT, withArgs, type ArgReader } from './arguments.ts';
import type { AutomataService } from './automata-service.ts';
import type { CurrentTurn } from './current-turn.ts';
import type { ActionHandler } from './dispatch.ts';
import type { Result } from '../shared/index.ts';
import type { TrustedTurnScope } from './trusted-scope.ts';

const REVISION = { min: 1, max: 1_000_000 } as const;
const MAX_TURNS = { min: 1, max: 16 } as const;
const GRANT_ACTIONS_MAX = 32;

type Handlers = Readonly<Record<string, ActionHandler>>;

/** `automata` tool actions. Authority for a spawn comes from the calling scope; the grant can only narrow it. */
export function automataHandlers(automata: AutomataService): Handlers {
  const runId = (a: ArgReader) => a.id('worker_run', 'runId');
  return {
    spawn: (scope, args) =>
      withArgs(
        args,
        ['spawnId', 'label', 'task', 'actions', 'maxTurns', 'maxSensitivity'],
        (a) => ({
          spawnId: a.id('spawn', 'spawnId'),
          label: a.string('label'),
          task: a.string('task'),
          grant: {
            actions: grantActions(a),
            maxTurns: a.integer('maxTurns', MAX_TURNS),
            maxSensitivity: a.oneOf('maxSensitivity', SENSITIVITIES),
          },
        }),
        (input) => automata.spawn(scope, input),
      ),
    message: (scope, args) =>
      withArgs(args, ['runId', 'text'], (a) => ({ runId: runId(a), text: a.string('text') }), (input) => automata.message(scope, input)),
    wait: (scope, args) => withArgs(args, ['runId'], (a) => ({ runId: runId(a) }), (input) => automata.wait(scope, input)),
    cancel: (scope, args) => withArgs(args, ['runId'], (a) => ({ runId: runId(a) }), (input) => automata.cancel(scope, input)),
    status: (scope, args) =>
      withArgs(
        args,
        ['runId', 'limit'],
        (a) => ({ runId: a.optionalId('worker_run', 'runId'), limit: a.integer('limit', LIMIT) }),
        (input) => automata.status(scope, input),
      ),
    discover: (scope, args) =>
      withArgs(args, ['query', 'limit'], (a) => ({ query: a.string('query'), limit: a.integer('limit', LIMIT) }), (input) => automata.discover(scope, input)),
    inspect: (scope, args) => withArgs(args, ['runId'], (a) => ({ runId: runId(a) }), (input) => automata.inspect(scope, input)),
  };
}

/** `tool.action` names; unknown or worker-closed ones are refused by `deriveWorkerScope`, never trimmed. */
function grantActions(a: ArgReader): readonly { readonly tool: string; readonly action: string }[] {
  const names = a.stringArray('actions');
  if (names.length > GRANT_ACTIONS_MAX) a.issues.push(`a grant names at most ${GRANT_ACTIONS_MAX} actions`);
  const parsed: { tool: string; action: string }[] = [];
  for (const name of names) {
    const [tool, action, ...rest] = name.split('.');
    if (tool === undefined || action === undefined || rest.length > 0 || tool.length === 0 || action.length === 0) {
      a.issues.push(`grant action ${name} must be tool.action`);
      continue;
    }
    parsed.push({ tool, action });
  }
  return parsed;
}

/** `activity` tool actions. A new activity is bound to the current turn as the durable state records it. */
export function activityHandlers(
  activity: ActivityService,
  locate: (scope: TrustedTurnScope) => Promise<Result<CurrentTurn>>,
): Handlers {
  return {
    recent: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => activity.recent(scope, input)),
    get: (scope, args) => withArgs(args, ['activityId'], (a) => ({ id: a.id('activity', 'activityId') }), (input) => activity.get(scope, input.id)),
    start: (scope, args) =>
      withArgs(
        args,
        ['purpose'],
        (a) => ({ purpose: a.string('purpose') }),
        async (input) => {
          const turn = await locate(scope);
          return turn.ok ? activity.start(scope, { purpose: input.purpose, ...turn.value }) : turn;
        },
      ),
    update: (scope, args) =>
      withArgs(
        args,
        ['activityId', 'expectedRevision', 'status', 'outcome', 'artifacts', 'note'],
        (a) => {
          const status = a.optionalOneOf('status', ACTIVITY_STATUSES.filter((s) => s !== 'in_progress'));
          const outcome = a.optionalString('outcome');
          const note = a.optionalString('note');
          const artifacts = a.has('artifacts') ? artifactList(a, args['artifacts']) : null;
          return {
            id: a.id('activity', 'activityId'),
            expectedRevision: a.integer('expectedRevision', REVISION),
            ...(status === null ? {} : { status }),
            ...(outcome === null ? {} : { outcome }),
            ...(note === null ? {} : { note }),
            ...(artifacts === null ? {} : { artifacts }),
          };
        },
        (input) => activity.update(scope, input),
      ),
  };
}

function artifactList(a: ArgReader, raw: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(raw)) {
    a.issues.push('artifacts must be an array of { kind, ref }');
    return [];
  }
  const out: ArtifactRef[] = [];
  for (const item of raw) {
    if (!isRecord(item) || Object.keys(item).some((k) => k !== 'kind' && k !== 'ref')) {
      a.issues.push('each artifact is { kind, ref }');
      continue;
    }
    const { kind, ref } = item;
    if (typeof kind !== 'string' || typeof ref !== 'string' || kind.trim().length === 0 || ref.trim().length === 0 || kind.length > 64 || ref.length > 500) {
      a.issues.push('artifact kind (1-64) and ref (1-500) must be non-empty strings');
      continue;
    }
    out.push({ kind, ref });
  }
  return out;
}
