import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOMAINS,
  DONOR_REVISION,
  SENSITIVITIES,
  TOOL_INVENTORY,
  resolveAction,
  type ActionDescriptor,
  type PrivacyClass,
} from '../../packages/core/src/index.ts';
import { renderToolInventory } from './render-tool-inventory.ts';

const PRIVACY: readonly PrivacyClass[] = [
  'identity_by_design',
  'audience_scoped',
  'conversation_scoped',
  'companion_private',
  'automata_private',
];

const allActions = (): { tool: string; action: ActionDescriptor }[] =>
  TOOL_INVENTORY.flatMap((tool) => tool.actions.map((action) => ({ tool: tool.name, action })));

const find = (tool: string, action: string): ActionDescriptor => {
  const resolved = resolveAction(TOOL_INVENTORY, tool, action);
  if (!resolved.ok) throw new Error(`${tool}.${action} missing`);
  return resolved.value.action;
};

describe('tool inventory', () => {
  it('gives every domain a tool and covers the required companion surface', () => {
    for (const domain of DOMAINS) {
      expect(TOOL_INVENTORY.some((t) => t.domain === domain), `${domain} has a tool`).toBe(true);
    }
    expect(TOOL_INVENTORY.map((t) => t.name).sort()).toEqual(
      ['activity', 'automata', 'concern', 'contact', 'emotion', 'episode', 'free_time', 'journal', 'memory', 'orient', 'session', 'values'].sort(),
    );
  });

  it('has unique tool names and unique action names within each tool', () => {
    const names = TOOL_INVENTORY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOL_INVENTORY) {
      const actions = tool.actions.map((a) => a.name);
      expect(new Set(actions).size, tool.name).toBe(actions.length);
      expect(actions.length, tool.name).toBeGreaterThan(0);
    }
  });

  it('declares owner, privacy, admission and donor mapping for every action', () => {
    expect(DONOR_REVISION).toMatch(/^[0-9a-f]{40}$/);
    for (const { tool, action } of allActions()) {
      const label = `${tool}.${action.name}`;
      expect(DOMAINS).toContain(TOOL_INVENTORY.find((t) => t.name === tool)?.domain);
      expect(PRIVACY, label).toContain(action.privacy);
      expect(SENSITIVITIES, label).toContain(action.admission);
      expect(action.summary.length, label).toBeGreaterThan(0);
      if (action.donor.kind === 'donor') {
        expect(action.donor.paths.length, label).toBeGreaterThan(0);
        for (const path of action.donor.paths) expect(path, label).toMatch(/^src\/[\w./-]+\.ts$/);
      } else {
        expect(action.donor.rationale.length, label).toBeGreaterThan(20);
        expect(action.donor.related.length, label).toBeGreaterThan(0);
        for (const path of action.donor.related) expect(path, label).toMatch(/^src\/[\w./-]+\.ts$/);
      }
    }
  });

  it('declares restrictions on every write action', () => {
    for (const { tool, action } of allActions()) {
      if (action.access === 'write') expect(action.restrictions.length, `${tool}.${action.name}`).toBeGreaterThan(0);
    }
  });

  it('keeps companion-private material behind a confidential admission and self actions private', () => {
    for (const { tool, action } of allActions()) {
      const label = `${tool}.${action.name}`;
      if (action.privacy === 'companion_private') expect(action.admission, label).toBe('confidential');
      if (action.restrictions.includes('self_audience_only')) expect(action.privacy, label).toBe('companion_private');
    }
  });

  it('encodes the review and write restrictions the charter requires', () => {
    expect(TOOL_INVENTORY.find((t) => t.name === 'memory')?.actions.map((a) => a.name)).not.toContain('delete');
    expect(find('memory', 'propose_delete').restrictions).toContain('proposal_only');
    for (const { tool, action } of allActions()) {
      const label = `${tool}.${action.name}`;
      if (action.restrictions.includes('proposal_only')) expect(action.workers, label).toBe('denied');
      if (tool === 'contact' || tool === 'automata') expect(action.workers, label).toBe('denied');
    }
    for (const name of ['propose_delete', 'restore', 'patch']) expect(find('memory', name).workers).toBe('denied');
    expect(find('memory', 'write').workers).toBe('review_staged');
    expect(find('contact', 'propose_trust').restrictions).toContain('proposal_only');
    expect(find('contact', 'set_relationship').restrictions).toContain('approval_for_protected');
    expect(find('orient', 'update_layer').restrictions).toContain('approval_for_protected');
    expect(find('orient', 'update_persona').restrictions).toContain('approval_for_protected');
    expect(find('concern', 'resolve').restrictions).toContain('visibility_gated');
    expect(find('concern', 'transition').restrictions).toContain('visibility_gated');
    expect(find('automata', 'spawn').restrictions).toContain('grant_narrowing');
    expect(find('episode', 'author_meaning').restrictions).toEqual(
      expect.arrayContaining(['companion_authored', 'self_audience_only']),
    );
    for (const name of ['choose', 'rest', 'defer']) expect(find('free_time', name).restrictions).toContain('self_audience_only');
  });

  it('leaves excluded donor surfaces out', () => {
    const tools = TOOL_INVENTORY.map((t) => t.name);
    for (const excluded of ['wiki', 'notify', 'system', 'self_status', 'analysis_workbench', 'automata_bus', 'skill']) {
      expect(tools).not.toContain(excluded);
    }
    const actions = allActions().map(({ action }) => action.name);
    for (const excluded of ['commit_stage', 'cancel_stage', 'introspection_consent_set', 'redact']) {
      expect(actions).not.toContain(excluded);
    }
  });

  it('is frozen runtime data', () => {
    expect(Object.isFrozen(TOOL_INVENTORY)).toBe(true);
    const memory = TOOL_INVENTORY.find((t) => t.name === 'memory');
    expect(memory && Object.isFrozen(memory.actions[0]?.restrictions)).toBe(true);
    expect(() => {
      (TOOL_INVENTORY as unknown as unknown[]).push({});
    }).toThrow(TypeError);
  });

  it('is documented in docs/tool-inventory.md exactly as registered', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'tool-inventory.md'), 'utf8');
    const match = /<!-- inventory:start -->\n([\s\S]*?)\n<!-- inventory:end -->/.exec(doc);
    expect(match?.[1]).toBe(renderToolInventory(TOOL_INVENTORY));
  });
});
