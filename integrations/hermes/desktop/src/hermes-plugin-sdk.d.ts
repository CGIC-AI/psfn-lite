/**
 * The part of Hermes Desktop's plugin SDK the Garden uses, as Hermes 2bd378e
 * declares it. Desktop rewrites the bare `@hermes/plugin-sdk` import of a
 * runtime plugin to its live SDK (apps/desktop/src/contrib/runtime-loader.ts),
 * so nothing here is bundled.
 *
 * Sources: apps/desktop/src/contrib/plugin.ts (HermesPlugin, PluginContext,
 * PluginContribution, PluginStorage), apps/desktop/src/api/plugins.ts
 * (PluginRestOptions), apps/desktop/src/app/routes.ts (ROUTES_AREA,
 * SIDEBAR_NAV_AREA, RouteContribution, SidebarNavContribution),
 * apps/desktop/src/sdk/areas.ts (PANES_AREA), apps/desktop/src/lib/transcript-
 * directives.ts (TRANSCRIPT_DIRECTIVE_AREA, its contribution and props), and
 * apps/desktop/src/sdk/index.ts (`host.navigate`).
 */
declare module '@hermes/plugin-sdk' {
  import type { ReactNode } from 'react';

  export const ROUTES_AREA: 'routes';
  export const SIDEBAR_NAV_AREA: 'sidebar.nav';
  export const PANES_AREA: 'panes';
  export const TRANSCRIPT_DIRECTIVE_AREA: 'transcript.directives';

  export const host: {
    /** Navigates the workspace to a route path, e.g. a contributed page. */
    navigate(path: string): void;
  };

  export interface PluginRestOptions {
    method?: string;
    body?: unknown;
    timeoutMs?: number;
  }

  export interface PluginContribution {
    id: string;
    area: string;
    title?: string;
    order?: number;
    enabled?: boolean;
    render?: () => ReactNode;
    data?: unknown;
  }

  export interface PluginStorage {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  }

  export interface PluginContext {
    readonly source: string;
    register(contribution: PluginContribution): () => void;
    registerMany(contributions: PluginContribution[]): () => void;
    onDispose(dispose: () => void): void;
    /** REST to this plugin's own backend namespace, `/api/plugins/<id><path>`. */
    rest<T>(path: string, options?: PluginRestOptions): Promise<T>;
    storage: PluginStorage;
  }

  export interface HermesPlugin {
    id: string;
    name?: string;
    description?: string;
    defaultEnabled?: boolean;
    register(ctx: PluginContext): void;
  }

  export interface RouteContribution {
    /** Absolute path, one segment, no params. */
    path: string;
  }

  export interface SidebarNavContribution {
    /** Codicon name. */
    codicon: string;
    label: string;
    path: string;
  }

  export interface TranscriptDirectiveProps {
    /** Parsed attributes: untrusted model output. */
    attrs: Readonly<Record<string, string>>;
    source: string;
    streaming: boolean;
    sessionId?: string | null;
  }

  export interface TranscriptDirectiveContribution {
    /** `::<name>{...}`: lowercase `[a-z0-9-]`, unique across plugins. */
    name: string;
    render(props: TranscriptDirectiveProps): ReactNode;
  }
}
