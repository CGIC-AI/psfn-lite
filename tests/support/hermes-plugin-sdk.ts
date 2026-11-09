/**
 * A stand-in for Hermes Desktop's `@hermes/plugin-sdk` (vitest.config.ts
 * aliases the specifier here). The area names are Desktop's own at Hermes
 * 2bd378e: apps/desktop/src/app/routes.ts (`routes`, `sidebar.nav`),
 * apps/desktop/src/sdk/areas.ts (`panes`) and apps/desktop/src/lib/
 * transcript-directives.ts (`transcript.directives`). `host.navigate` records
 * the paths it was asked for.
 */
export const ROUTES_AREA = 'routes';
export const SIDEBAR_NAV_AREA = 'sidebar.nav';
export const PANES_AREA = 'panes';
export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directives';

export const navigations: string[] = [];

export const host = {
  navigate(path: string): void {
    navigations.push(path);
  },
};
