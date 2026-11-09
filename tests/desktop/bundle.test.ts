/**
 * The committed Desktop half (integrations/hermes/psfn_lite/desktop/plugin.js)
 * is the build of integrations/hermes/desktop/src, and it is what Hermes
 * Desktop's runtime loader accepts (apps/desktop/src/contrib/runtime-loader.ts
 * at Hermes 2bd378e): one plain ESM file, no JSX, importing only
 * `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, whose default export
 * is a plugin with an id and a register function. The id is the plugin's
 * name everywhere, so `ctx.rest` reaches the `psfn_lite` dashboard backend.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { collectSpecifiers } from '../boundary/import-checker.ts';
import { EXTERNALS, OUTFILE, bundleText } from '../../integrations/hermes/desktop/build.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const BUNDLE = join(REPO, 'integrations', 'hermes', 'psfn_lite', 'desktop', 'plugin.js');

/** The built file, loaded as Desktop loads it (vitest resolves its `@hermes/plugin-sdk` to the stand-in). */
async function built<T>(): Promise<T> {
  return ((await import(/* @vite-ignore */ BUNDLE)) as { default: T }).default;
}

interface Registered {
  readonly id: string;
  readonly area: string;
  readonly title?: string;
  readonly data?: unknown;
}

describe('the Desktop half bundle', () => {
  const committed = readFileSync(BUNDLE, 'utf8');

  it('is the committed build of the source, byte for byte', async () => {
    expect(OUTFILE).toBe(BUNDLE);
    // Rebuild with `node integrations/hermes/desktop/build.mjs` after changing the source.
    expect(await bundleText()).toBe(committed);
  });

  it('imports only what Desktop provides and holds no JSX', async () => {
    const { specifiers, nonLiteral } = collectSpecifiers(BUNDLE, committed);
    expect(nonLiteral).toBe(0);
    expect([...new Set(specifiers)].sort()).toEqual([...EXTERNALS].sort());
    // Plain JavaScript: a JSX element left in the file fails to parse as js.
    await expect(transform(committed, { loader: 'js', format: 'esm' })).resolves.toBeDefined();
  });

  it('is named psfn_lite like the plugin, its manifests and the install tool', async () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'integrations', 'hermes', 'psfn_lite', 'dashboard', 'manifest.json'), 'utf8')) as { name: string };
    const yaml = readFileSync(join(REPO, 'integrations', 'hermes', 'psfn_lite', 'plugin.yaml'), 'utf8');
    const install = readFileSync(join(REPO, 'integrations', 'hermes', 'install_plugin.py'), 'utf8');
    const plugin = await built<{ id: string; register: unknown }>();
    expect(plugin.id).toBe(manifest.name);
    expect(yaml).toMatch(new RegExp(`^name: ${plugin.id}$`, 'm'));
    expect(install).toContain(`NAME = "${plugin.id}"`);
    expect(typeof plugin.register).toBe('function');
  });

  it('registers the Garden: a sidebar entry, a route per screen and the two directives', async () => {
    const plugin = await built<{ register: (ctx: unknown) => void }>();
    const registered: Registered[] = [];
    const stored = new Map<string, unknown>();
    plugin.register({
      source: 'plugin:psfn_lite',
      register: (c: Registered) => {
        registered.push(c);
        return () => undefined;
      },
      registerMany: (cs: Registered[]) => {
        registered.push(...cs);
        return () => undefined;
      },
      onDispose: () => undefined,
      rest: () => Promise.reject(new Error('not called while registering')),
      storage: { get: (key: string, fallback: unknown) => (stored.has(key) ? stored.get(key) : fallback), set: (key: string, value: unknown) => stored.set(key, value) },
    });
    const byArea = (area: string) => registered.filter((c) => c.area === area);
    expect(byArea('routes').map((c) => (c.data as { path: string }).path)).toEqual([
      '/garden', '/garden-memories', '/garden-persona', '/garden-people', '/garden-sessions', '/garden-inner-life', '/garden-automata', '/garden-settings',
    ]);
    expect(byArea('sidebar.nav').map((c) => c.data)).toEqual([{ codicon: 'heart', label: 'Garden', path: '/garden' }]);
    expect(byArea('transcript.directives').map((c) => (c.data as { name: string }).name)).toEqual(['garden-memory', 'garden-layer-diff']);
    // The side pane is opt-in: nothing in the workspace until the operator opens it.
    expect(byArea('panes')).toEqual([]);
  });
});
