/**
 * The MCP argument descriptions must name exactly the keys each core handler
 * accepts. The handlers declare them as the literal key list passed to
 * `withArgs`; this test reads those lists from the handler sources with the
 * TypeScript compiler and compares them with `ACTION_ARGUMENTS`, so a
 * handler change that is not reflected in the transport fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TOOL_INVENTORY } from '../../packages/core/src/index.ts';
import { ACTION_ARGUMENTS } from '../../packages/mcp/src/index.ts';

const APPLICATION = join(import.meta.dirname, '..', '..', 'packages', 'core', 'src', 'application');

/** Handler factories and the inventory tool each serves. */
const FACTORIES: Readonly<Record<string, string>> = {
  orientHandlers: 'orient',
  valuesHandlers: 'values',
  sessionHandlers: 'session',
  contactHandlers: 'contact',
  memoryHandlers: 'memory',
  episodeHandlers: 'episode',
  journalHandlers: 'journal',
  emotionHandlers: 'emotion',
  concernHandlers: 'concern',
  reminderHandlers: 'concern',
  automataHandlers: 'automata',
  activityHandlers: 'activity',
  freeTimeHandlers: 'free_time',
};

function withArgsKeys(node: ts.Node): string[] | null {
  let found: string[] | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'withArgs') {
      const list = n.arguments[1];
      if (list !== undefined && ts.isArrayLiteralExpression(list)) {
        found = list.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : `<non-literal ${e.getText()}>`));
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `tool.action` -> accepted keys, read from every handler factory's returned object literal. */
function handlerKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(APPLICATION).filter((f) => f.startsWith('handlers-') && f.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(join(APPLICATION, file), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
      const tool = FACTORIES[statement.name.text];
      if (tool === undefined || statement.body === undefined) continue;
      const returned = statement.body.statements.find((s): s is ts.ReturnStatement => ts.isReturnStatement(s));
      const literal = returned?.expression;
      if (literal === undefined || !ts.isObjectLiteralExpression(literal)) throw new Error(`${statement.name.text} does not return an object literal`);
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const action = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : property.name.getText();
        const keys = withArgsKeys(property.initializer);
        if (keys === null) throw new Error(`${tool}.${action} does not declare its keys through withArgs`);
        out.set(`${tool}.${action}`, keys);
      }
    }
  }
  return out;
}

describe('MCP argument descriptions', () => {
  it('cover every inventory action with exactly the keys its core handler accepts', () => {
    const handlers = handlerKeys();
    const inventory = TOOL_INVENTORY.flatMap((t) => t.actions.map((a) => `${t.name}.${a.name}`));
    expect([...handlers.keys()].sort()).toEqual([...inventory].sort());
    for (const name of inventory) {
      const [tool = '', action = ''] = name.split('.');
      const described = Object.keys(ACTION_ARGUMENTS[tool]?.[action] ?? {}).sort();
      expect(described, name).toEqual([...(handlers.get(name) ?? [])].sort());
    }
  });

  it('describe no tool or action the inventory lacks', () => {
    for (const [tool, actions] of Object.entries(ACTION_ARGUMENTS)) {
      const declared = TOOL_INVENTORY.find((t) => t.name === tool);
      expect(declared, tool).toBeDefined();
      for (const action of Object.keys(actions)) expect(declared?.actions.some((a) => a.name === action), `${tool}.${action}`).toBe(true);
    }
  });
});
