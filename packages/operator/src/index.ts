/**
 * PSFN Lite light Garden (seam S8): a host-neutral operator surface over the
 * running companion. It composes the donor Garden services of the eight
 * screens over the companion's own instances and serves them, with a few
 * Lite routes, as an authenticated loopback JSON API for the primary
 * contact. A host (the standalone app) mounts it; the Hermes plugin proxies
 * to it.
 */
export { GARDEN_AUDIT_FILE, GardenAudit, type GardenAuditInput } from './audit.ts';
export { composeGardenServices, type GardenCompanion, type GardenOperator, type GardenOwnerFiles, type GardenServices } from './garden.ts';
export { buildDonorGardenRoutes, type DonorGardenRoute } from './donor-routes.ts';
export { LITE_PREFIX, buildLiteRoutes, type GardenHostFacts, type LiteRoute } from './lite-routes.ts';
export { startGardenServer, type GardenErrorReport, type GardenServer, type GardenServerOptions } from './http.ts';
