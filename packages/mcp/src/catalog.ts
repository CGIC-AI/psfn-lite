import { isDeepStrictEqual } from 'node:util';
import { invalid, ok, type ActionDescriptor, type Result, type ToolDescriptor } from './core.ts';
import type { ActionArguments, JsonSchema, ToolArguments } from './schema.ts';

/** The `_meta` key carrying each tool's per-action inventory data. */
export const ACTIONS_META_KEY = 'psfn-lite/actions';

export interface ActionCatalogEntry {
  readonly name: string;
  readonly summary: string;
  readonly access: ActionDescriptor['access'];
  readonly privacy: ActionDescriptor['privacy'];
  readonly admission: ActionDescriptor['admission'];
  readonly restrictions: ActionDescriptor['restrictions'];
  readonly workers: ActionDescriptor['workers'];
  readonly inference: ActionDescriptor['inference'];
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** One MCP tool, as `tools/list` returns it. */
export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
  readonly annotations: { readonly readOnlyHint: boolean; readonly openWorldHint: false };
  readonly _meta: { readonly [ACTIONS_META_KEY]: readonly ActionCatalogEntry[] };
}

/**
 * Builds exactly one MCP tool per inventory tool, with an `action`
 * discriminator whose values are the inventory's actions. Names, summaries
 * and restrictions come from the inventory; argument properties come from
 * the per-action descriptions. An inventory action without a description,
 * or a description for something the inventory lacks, refuses the catalog.
 *
 * The schema requires only `action` and does not close the property set:
 * core's argument readers decide what a call accepts, so a call carrying an
 * unknown or authority-shaped argument reaches core and is refused there,
 * visibly, rather than being filtered in the transport.
 */
export function buildToolCatalog(
  inventory: readonly ToolDescriptor[],
  descriptions: Readonly<Record<string, ToolArguments>>,
): Result<readonly McpToolDefinition[]> {
  const issues: string[] = [];
  for (const tool of Object.keys(descriptions)) {
    const declared = inventory.find((t) => t.name === tool);
    if (declared === undefined) {
      issues.push(`arguments describe unknown tool ${tool}`);
      continue;
    }
    for (const action of Object.keys(descriptions[tool] ?? {})) {
      if (!declared.actions.some((a) => a.name === action)) issues.push(`arguments describe unknown action ${tool}.${action}`);
    }
  }
  const tools: McpToolDefinition[] = [];
  for (const tool of inventory) {
    const described = descriptions[tool.name];
    const missing = tool.actions.filter((a) => described?.[a.name] === undefined).map((a) => `${tool.name}.${a.name}`);
    if (described === undefined || missing.length > 0) {
      issues.push(`no argument description for ${missing.join(', ')}`);
      continue;
    }
    const built = toolDefinition(tool, described);
    if (!built.ok) issues.push(...(built.error.kind === 'invalid' ? built.error.issues : [`${tool.name} could not be described`]));
    else tools.push(built.value);
  }
  return issues.length > 0 ? invalid(...issues) : ok(tools);
}

function toolDefinition(tool: ToolDescriptor, described: ToolArguments): Result<McpToolDefinition> {
  const entries = tool.actions.map((action) => catalogEntry(action, described[action.name] ?? {}));
  const properties = mergeProperties(tool, described);
  return ok({
    name: tool.name,
    title: `${tool.name} (${tool.domain})`,
    description: describeTool(tool, entries),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: tool.actions.map((a) => a.name), description: 'The action to run; see the tool description for each action’s arguments.' },
        ...properties,
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: tool.actions.every((a) => a.access === 'read'), openWorldHint: false },
    _meta: { [ACTIONS_META_KEY]: entries },
  });
}

function catalogEntry(action: ActionDescriptor, args: ActionArguments): ActionCatalogEntry {
  const names = Object.keys(args);
  return {
    name: action.name,
    summary: action.summary,
    access: action.access,
    privacy: action.privacy,
    admission: action.admission,
    restrictions: action.restrictions,
    workers: action.workers,
    inference: action.inference,
    required: names.filter((n) => args[n]?.required === true),
    optional: names.filter((n) => args[n]?.required !== true),
  };
}

/** One property per argument name; a name whose shape differs between actions lists each shape. */
function mergeProperties(tool: ToolDescriptor, described: ToolArguments): Record<string, JsonSchema> {
  const shapes = new Map<string, { schemas: JsonSchema[]; actions: string[] }>();
  for (const action of tool.actions) {
    for (const [name, spec] of Object.entries(described[action.name] ?? {})) {
      const entry = shapes.get(name) ?? { schemas: [], actions: [] };
      if (!entry.schemas.some((s) => isDeepStrictEqual(s, spec.schema))) entry.schemas.push(spec.schema);
      entry.actions.push(action.name);
      shapes.set(name, entry);
    }
  }
  const out: Record<string, JsonSchema> = {};
  for (const [name, { schemas, actions }] of shapes) {
    const usedBy = `Used by: ${actions.join(', ')}.`;
    const [only] = schemas;
    out[name] =
      schemas.length === 1 && only !== undefined
        ? { ...only, description: `${typeof only['description'] === 'string' ? `${only['description']} ` : ''}${usedBy}` }
        : { anyOf: schemas, description: usedBy };
  }
  return out;
}

function describeTool(tool: ToolDescriptor, entries: readonly ActionCatalogEntry[]): string {
  const lines = entries.map((e) => {
    const args = [...e.required.map((n) => `${n} (required)`), ...e.optional].join(', ');
    const notes = [e.access, e.privacy, `admission ${e.admission}`, ...e.restrictions, ...(e.inference === 'may_call_model' ? ['may call model'] : [])];
    return `- ${e.name} [${notes.join('; ')}]: ${e.summary}${args.length > 0 ? ` Arguments: ${args}.` : ' No arguments.'}`;
  });
  return [
    tool.summary,
    'Caller, contact and audience are bound by the server from the transport credential; arguments never carry identity.',
    'Actions:',
    ...lines,
  ].join('\n');
}
