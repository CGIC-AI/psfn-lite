/**
 * The light Garden in Hermes Desktop: a "Garden" sidebar entry, one route per
 * screen, an optional side pane for the deletions the companion asked for,
 * and two transcript directives. It follows the bundled Kanban plugin
 * (apps/desktop/src/plugins/kanban/plugin.tsx at Hermes 2bd378e): routes and
 * the sidebar row through `ctx.registerMany`, data through `ctx.rest` to the
 * plugin's own dashboard backend (`psfn_lite/dashboard/plugin_api.py`).
 *
 * The id is the plugin's name everywhere: Desktop sends `ctx.rest('/x')` to
 * `/api/plugins/<id>/x`, where Hermes mounts the `psfn_lite` dashboard backend.
 * Only this module imports the SDK; the screens get `rest` and `navigate`.
 */
import { useSyncExternalStore } from 'react';
import {
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  TRANSCRIPT_DIRECTIVE_AREA,
  host,
  type HermesPlugin,
  type PluginContext,
  type PluginContribution,
  type RouteContribution,
  type SidebarNavContribution,
  type TranscriptDirectiveContribution,
} from '@hermes/plugin-sdk';
import type { Garden, Rest } from './api.ts';
import { LAYER_DIFF_DIRECTIVE, LayerDiffDirective, MEMORY_DIRECTIVE, MemoryDirective } from './directives.tsx';
import { DeletionProposals, GardenScreen, type PaneToggle } from './screens.tsx';
import { SCREENS, type ScreenKey } from './ui.tsx';

export const PLUGIN_ID = 'psfn_lite';
const PANE_KEY = 'deletionsPane';

interface PaneStore {
  readonly shown: () => boolean;
  readonly set: (on: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The side pane is registered only while the operator keeps it open; the choice is remembered. */
function deletionsPane(ctx: PluginContext, garden: Garden): PaneStore {
  let remove: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (on: boolean) => {
    if (on && remove === null) {
      remove = ctx.register({
        id: 'deletions',
        area: PANES_AREA,
        title: 'Memory deletions',
        data: { placement: 'right', collapsible: true },
        render: () => (
          <div style={{ padding: '8px 10px', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
            <DeletionProposals garden={garden} />
          </div>
        ),
      });
    } else if (!on && remove !== null) {
      remove();
      remove = null;
    }
    ctx.storage.set(PANE_KEY, on);
    for (const listener of listeners) listener();
  };
  return {
    shown: () => remove !== null,
    set,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function Routed({ garden, screen, pane }: { garden: Garden; screen: ScreenKey; pane: PaneStore }) {
  const shown = useSyncExternalStore(pane.subscribe, pane.shown);
  const toggle: PaneToggle = { shown, toggle: () => pane.set(!shown) };
  return <GardenScreen garden={garden} screen={screen} pane={toggle} />;
}

export function gardenContributions(ctx: PluginContext): PluginContribution[] {
  const rest: Rest = (target, options) => ctx.rest(target, options);
  const garden: Garden = { rest, navigate: (target) => host.navigate(target) };
  const pane = deletionsPane(ctx, garden);
  if (ctx.storage.get<boolean>(PANE_KEY, false)) pane.set(true);
  const routes: PluginContribution[] = SCREENS.map((screen) => ({
    id: `route-${screen.key}`,
    area: ROUTES_AREA,
    title: screen.key === 'overview' ? 'Garden' : `Garden · ${screen.title}`,
    data: { path: screen.path } satisfies RouteContribution,
    render: () => <Routed garden={garden} screen={screen.key} pane={pane} />,
  }));
  const memory: TranscriptDirectiveContribution = { name: MEMORY_DIRECTIVE, render: ({ attrs }) => <MemoryDirective rest={rest} attrs={attrs} /> };
  const layerDiff: TranscriptDirectiveContribution = { name: LAYER_DIFF_DIRECTIVE, render: ({ attrs }) => <LayerDiffDirective rest={rest} attrs={attrs} /> };
  return [
    ...routes,
    { id: 'nav', area: SIDEBAR_NAV_AREA, order: 55, data: { codicon: 'heart', label: 'Garden', path: '/garden' } satisfies SidebarNavContribution },
    { id: 'directive-memory', area: TRANSCRIPT_DIRECTIVE_AREA, data: memory },
    { id: 'directive-layer-diff', area: TRANSCRIPT_DIRECTIVE_AREA, data: layerDiff },
  ];
}

const plugin: HermesPlugin = {
  id: PLUGIN_ID,
  name: 'Garden',
  description: 'The PSFN Lite companion’s light Garden: memories, persona and prompts, people, sessions, inner life, automata and settings.',
  register(ctx) {
    ctx.registerMany(gardenContributions(ctx));
  },
};

export default plugin;
