import { CORE_BLOCK_NAMES, PERSONA_FIELDS } from '../core.ts';
import { NO_ARGUMENTS, limit, optional, required, schema, type ToolArguments } from '../schema.ts';

const VERSION = { min: 1, max: 1_000_000 } as const;
const LIST_PERSONA_FIELDS: readonly string[] = ['alternate_greetings', 'tags'];

const block = required(schema.oneOf('Orientation block of the current conversation.', CORE_BLOCK_NAMES));
const layerId = required(schema.nonEmpty('Prompt layer id.'));
const reason = required(schema.nonEmpty('Why the change is made; recorded with the version.'));

const personaPatch = schema.object(
  'Persona card fields to change. Protected fields become an approval proposal.',
  Object.fromEntries(
    PERSONA_FIELDS.map((field) => [
      field,
      LIST_PERSONA_FIELDS.includes(field) ? schema.array(`Persona ${field}.`, { type: 'string' }) : schema.text(`Persona ${field}.`),
    ]),
  ),
);

export const ORIENT_ARGUMENTS: ToolArguments = {
  view: NO_ARGUMENTS,
  append: { block, text: required(schema.nonEmpty('Text appended to the block.')) },
  replace: {
    block,
    oldText: required(schema.nonEmpty('Exact text to replace.')),
    newText: required(schema.text('Replacement text; may be empty.')),
  },
  reorient: {
    persona: required(schema.text('New persona block.')),
    human: required(schema.text('New human block.')),
    goals: required(schema.text('New goals block.')),
  },
  list_layers: NO_ARGUMENTS,
  get_layer: { layerId },
  diff_layer: { layerId, version: optional(schema.integer('Layer version to compare with its predecessor (default: latest).', VERSION)) },
  layer_history: { layerId, limit: limit() },
  update_layer: { layerId, content: required(schema.nonEmpty('New layer content.')), reason },
  rollback_layer: { layerId, version: required(schema.integer('Version to roll back to.', VERSION)), reason },
  toggle_layer: { layerId, reason },
  update_persona: { patch: required(personaPatch), reason },
};

const itemId = required(schema.nonEmpty('North Star item id.'));

export const VALUES_ARGUMENTS: ToolArguments = {
  list_values: { limit: limit() },
  add_value: { value: required(schema.nonEmpty('The value, in the companion’s words.')), context: optional(schema.nonEmpty('What prompted it.')) },
  revise_value: {
    version: required(schema.integer('Version of the value being revised.', VERSION)),
    value: required(schema.nonEmpty('Revised value.')),
    context: optional(schema.nonEmpty('What prompted the revision.')),
  },
  north_star_list: NO_ARGUMENTS,
  north_star_create: { title: required(schema.nonEmpty('Item title.')), content: required(schema.nonEmpty('Item content.')) },
  north_star_update: {
    itemId,
    title: optional(schema.nonEmpty('New title.')),
    content: optional(schema.nonEmpty('New content.')),
    enabled: optional(schema.boolean('Whether the item is active.')),
  },
  north_star_reorder: { order: required(schema.strings('Every item id exactly once, in the new order.')) },
  north_star_retire: { itemId },
};
