/**
 * The Hermes plugin registers the `automata_bus` tool for hosted automaton
 * attempts from a static schema file (integrations/hermes/psfn_lite/
 * automata_bus_tool.json), since the plugin is Python. Core's governed tool
 * validates every call, so the schema only tells the child's model what to
 * send; this test keeps it the donor tool's own name, description and
 * parameters.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATA_BUS_TOOL_ACTIONS,
  CANONICAL_TOOL_SURFACE_DESCRIPTIONS,
  automataBusToolParametersForActions,
} from '@cgic/psfn-core';

const SCHEMA = new URL('../../integrations/hermes/psfn_lite/automata_bus_tool.json', import.meta.url);

describe('the Hermes automata_bus tool schema', () => {
  it('is the donor tool surface: name, description and parameters', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as Record<string, unknown>;
    expect(schema).toEqual({
      name: 'automata_bus',
      description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.automata_bus,
      parameters: JSON.parse(JSON.stringify(automataBusToolParametersForActions(AUTOMATA_BUS_TOOL_ACTIONS))) as unknown,
    });
  });
});
