/**
 * The donor tool catalog as MCP tools, and the host tool port that runs an
 * MCP call inside the caller's open host-driven turn. Every donor tool the
 * SubstrateAgent registers (core and extended, donor tool-runtime-facade
 * getToolCatalog) becomes one MCP tool with the donor's name, description
 * and TypeBox parameter schema. An extended tool the turn has not loaded is
 * answered by the donor loop exactly as a SubstrateAgent model's call would
 * be (its unknown-tool correction naming `toolset`).
 */
import type { HostToolPort, McpToolDefinition } from './mcp.ts';
import type { HostTurnBridge } from './bridge.ts';

/** The part of a donor tool the catalog reads. */
export interface DonorTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface DonorToolCatalog {
  getToolCatalog(): { readonly core: readonly DonorTool[]; readonly extended: readonly DonorTool[] };
}

function schemaOf(parameters: unknown): McpToolDefinition['inputSchema'] {
  // TypeBox schemas are JSON Schema plus symbol-keyed metadata; a JSON round trip keeps the schema only.
  const plain = parameters === undefined ? {} : (JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>);
  return { ...plain, type: 'object' };
}

export function donorToolDefinitions(catalog: DonorToolCatalog): readonly McpToolDefinition[] {
  const { core, extended } = catalog.getToolCatalog();
  const seen = new Set<string>();
  const out: McpToolDefinition[] = [];
  for (const tool of [...core, ...extended]) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push({ name: tool.name, description: tool.description, inputSchema: schemaOf(tool.parameters) });
  }
  return out;
}

/** The MCP transport's tool port over the bridge. The catalog is read once: the donor registers its tools at start. */
export function createHostToolPort(catalog: DonorToolCatalog, bridge: HostTurnBridge): HostToolPort {
  let definitions: readonly McpToolDefinition[] | null = null;
  return {
    tools: () => (definitions ??= donorToolDefinitions(catalog)),
    call: (principal, name, args) => bridge.callTool(principal, name, args),
  };
}
