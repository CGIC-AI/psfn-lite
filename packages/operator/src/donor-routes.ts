/**
 * The donor Garden routes of the eight screens, built by the donor's own
 * route builders over the composed services, in the donor's order
 * (operator/garden/api-routes.ts:581-1136), and compiled against the route
 * authorization catalogue as the donor's buildAdminRoutes compiled them
 * (server-routes.ts:174-245). Every route answers under `/api/admin/`.
 */
import {
  assertGardenRouteDeclarationsCovered,
  buildAdminAutomataRoutes,
  buildAdminBiographicalReviewRoutes,
  buildAdminConcernRoutes,
  buildAdminContactRoutes,
  buildAdminGraphProposalRoutes,
  buildAdminIdentityRoutes,
  buildAdminMemoryRoutes,
  buildAdminPromptRoutes,
  buildAdminSchedulerRoutes,
  buildAdminSessionRoutes,
  compileGardenRouteDeclarations,
  type AdminApiRoute,
  type AdminBodyReader,
  type AuthorizedGardenRoute,
} from './companion.ts';
import { routeAppender } from './audit.ts';
import type { GardenServices } from './garden.ts';

export type DonorGardenRoute = AuthorizedGardenRoute<AdminApiRoute>;

export function buildDonorGardenRoutes(services: GardenServices, withBody: AdminBodyReader): DonorGardenRoute[] {
  const appendAuditTimelineEntry = routeAppender(services.audit);
  const routes = compileGardenRouteDeclarations([
    ...buildAdminAutomataRoutes({ automataService: services.automata }),
    ...buildAdminMemoryRoutes({ memoryService: services.memory, withBody }),
    ...buildAdminBiographicalReviewRoutes({ service: services.biographicalReview, withBody, appendAuditTimelineEntry }),
    ...buildAdminSessionRoutes({ sessionService: services.sessions, withBody }),
    ...buildAdminContactRoutes({ contactsService: services.contacts, withBody }),
    ...buildAdminGraphProposalRoutes({ graphProposalsService: services.graphProposals, withBody }),
    ...buildAdminConcernRoutes({ concernService: services.concerns, withBody }),
    ...buildAdminIdentityRoutes({ identityService: services.identity, appendAuditTimelineEntry, withBody }),
    ...buildAdminPromptRoutes({ promptsService: services.prompts, withBody }),
    ...buildAdminSchedulerRoutes({ scheduler: services.scheduler, withBody }),
  ]);
  assertGardenRouteDeclarationsCovered(routes);
  return routes;
}
