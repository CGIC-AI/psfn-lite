// Lite seam S8 (docs/extraction.md, "S8: the light Garden"): type copy of donor
// src/boundary/fleet-auth/request-capability.ts:158-166 at e6a9546. The kept Garden
// request context union names it; request-capability.ts (fleet request capability
// minting and verification) is cut with fleet auth.

export interface RequestCapabilityAuthorityVersions {
  readonly authorityGeneration: number;
  readonly globalAuthEpoch: number;
  readonly sessionAuthnVersion: number;
  readonly sessionAuthzVersion: number;
  readonly bindingVersion: number;
  readonly grantVersion: number;
  readonly policyVersion: number;
}
