import { CORE_BLOCK_NAMES, PERSONA_FIELDS, type PersonaPatch } from '../identity/index.ts';
import { isRecord } from '../shared/index.ts';
import { LIMIT, withArgs, type ArgReader } from './arguments.ts';
import type { ActionHandler } from './dispatch.ts';
import type { OrientationService } from './orientation-service.ts';
import type { ValuesService } from './values-service.ts';

const VERSION = { min: 1, max: 1_000_000 } as const;
const LIST_FIELDS: readonly string[] = ['alternate_greetings', 'tags'];

/** `orient` tool actions over the orientation service. */
export function orientHandlers(orientation: OrientationService): Readonly<Record<string, ActionHandler>> {
  return {
    view: (scope, args) => withArgs(args, [], () => null, () => orientation.view(scope)),
    append: (scope, args) =>
      withArgs(args, ['block', 'text'], (a) => ({ block: a.oneOf('block', CORE_BLOCK_NAMES), text: a.string('text') }), (input) =>
        orientation.append(scope, input),
      ),
    replace: (scope, args) =>
      withArgs(
        args,
        ['block', 'oldText', 'newText'],
        (a) => ({ block: a.oneOf('block', CORE_BLOCK_NAMES), oldText: a.string('oldText'), newText: a.text('newText') }),
        (input) => orientation.replace(scope, input),
      ),
    reorient: (scope, args) =>
      withArgs(
        args,
        ['persona', 'human', 'goals'],
        (a) => ({ persona: a.text('persona'), human: a.text('human'), goals: a.text('goals') }),
        (input) => orientation.reorient(scope, input),
      ),
    list_layers: (scope, args) => withArgs(args, [], () => null, () => orientation.listLayers(scope)),
    get_layer: (scope, args) => withArgs(args, ['layerId'], (a) => a.string('layerId'), (layerId) => orientation.getLayer(scope, layerId)),
    diff_layer: (scope, args) =>
      withArgs(
        args,
        ['layerId', 'version'],
        (a) => ({ layerId: a.string('layerId'), version: a.optionalInteger('version', VERSION) }),
        (input) => orientation.diffLayer(scope, input),
      ),
    layer_history: (scope, args) =>
      withArgs(args, ['layerId', 'limit'], (a) => ({ layerId: a.string('layerId'), limit: a.integer('limit', LIMIT) }), (input) =>
        orientation.layerHistory(scope, input),
      ),
    update_layer: (scope, args) =>
      withArgs(
        args,
        ['layerId', 'content', 'reason'],
        (a) => ({ layerId: a.string('layerId'), content: a.string('content'), reason: a.string('reason') }),
        (input) => orientation.updateLayer(scope, input),
      ),
    rollback_layer: (scope, args) =>
      withArgs(
        args,
        ['layerId', 'version', 'reason'],
        (a) => ({ layerId: a.string('layerId'), version: a.integer('version', VERSION), reason: a.string('reason') }),
        (input) => orientation.rollbackLayer(scope, input),
      ),
    toggle_layer: (scope, args) =>
      withArgs(args, ['layerId', 'reason'], (a) => ({ layerId: a.string('layerId'), reason: a.string('reason') }), (input) =>
        orientation.toggleLayer(scope, input),
      ),
    update_persona: (scope, args) =>
      withArgs(args, ['patch', 'reason'], (a) => ({ patch: personaPatch(a, args['patch']), reason: a.string('reason') }), (input) =>
        orientation.updatePersona(scope, input),
      ),
  };
}

/** `values` tool actions over the values service. */
export function valuesHandlers(values: ValuesService): Readonly<Record<string, ActionHandler>> {
  return {
    list_values: (scope, args) => withArgs(args, ['limit'], (a) => ({ limit: a.integer('limit', LIMIT) }), (input) => values.listValues(scope, input)),
    add_value: (scope, args) =>
      withArgs(args, ['value', 'context'], (a) => ({ value: a.string('value'), context: a.optionalString('context') }), (input) =>
        values.addValue(scope, input),
      ),
    revise_value: (scope, args) =>
      withArgs(
        args,
        ['version', 'value', 'context'],
        (a) => ({ version: a.integer('version', VERSION), value: a.string('value'), context: a.optionalString('context') }),
        (input) => values.reviseValue(scope, input),
      ),
    north_star_list: (scope, args) => withArgs(args, [], () => null, () => values.northStarList(scope)),
    north_star_create: (scope, args) =>
      withArgs(args, ['title', 'content'], (a) => ({ title: a.string('title'), content: a.string('content') }), (input) =>
        values.northStarCreate(scope, input),
      ),
    north_star_update: (scope, args) =>
      withArgs(
        args,
        ['itemId', 'title', 'content', 'enabled'],
        (a) => {
          const title = a.optionalString('title');
          const content = a.optionalString('content');
          const enabled = a.optionalBoolean('enabled');
          return {
            itemId: a.string('itemId'),
            ...(title === null ? {} : { title }),
            ...(content === null ? {} : { content }),
            ...(enabled === undefined ? {} : { enabled }),
          };
        },
        (input) => values.northStarUpdate(scope, input),
      ),
    north_star_reorder: (scope, args) =>
      withArgs(args, ['order'], (a) => ({ order: a.stringArray('order') }), (input) => values.northStarReorder(scope, input)),
    north_star_retire: (scope, args) => withArgs(args, ['itemId'], (a) => ({ itemId: a.string('itemId') }), (input) => values.northStarRetire(scope, input)),
  };
}

function personaPatch(reader: ArgReader, raw: unknown): PersonaPatch {
  if (!isRecord(raw)) {
    reader.issues.push('patch must be an object of persona fields');
    return {};
  }
  const patch: Record<string, string | readonly string[]> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!(PERSONA_FIELDS as readonly string[]).includes(field)) {
      reader.issues.push(`unknown persona field ${field}`);
    } else if (LIST_FIELDS.includes(field)) {
      if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) patch[field] = value;
      else reader.issues.push(`${field} must be an array of strings`);
    } else if (typeof value === 'string') {
      patch[field] = value;
    } else {
      reader.issues.push(`${field} must be a string`);
    }
  }
  return patch;
}
