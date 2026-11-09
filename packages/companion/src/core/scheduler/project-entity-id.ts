// ── Project entity id and visibility ──
//
// Lite extraction (seam 3.17, wiki cut). The free-time workspace resolver keeps
// its project-ref normalisation and visibility type; their donor home,
// faculties/wiki/personal-project-contracts.ts, is the wiki's personal-project
// document contract, which is not part of the core.
//
// Copied verbatim from the donor at e6a9546:
// src/faculties/wiki/personal-project-contracts.ts:9 (CompanionOwnedVisibility)
// and :128-141 (requiredProjectText, normalizeProjectEntityId).

export type CompanionOwnedVisibility = 'self' | 'primary_contact' | 'public';

export function requiredProjectText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeProjectEntityId(value: unknown, field: string): string {
  const id = requiredProjectText(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`${field} must contain only lowercase letters, digits, underscores, or hyphens`);
  }
  return id;
}
