// ── Runtime service health status (type-only) ──
//
// Lite extraction (seam 3.18): the one operator tool-health type the turn
// loop names. Copied verbatim from the donor's
// src/operator/tool-health/types.ts:1-5 at e6a9546; the operator Garden is cut.

export type RuntimeServiceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'not_applicable';
