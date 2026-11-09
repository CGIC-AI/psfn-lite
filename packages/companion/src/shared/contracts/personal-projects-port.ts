// ── Personal-projects port (free-time lane) ──
//
// Lite type copy (seam 3.11, wiki cut; extraction/cuts.tsv). The free-time lane
// reads the companion's personal projects through two methods of the donor
// wiki PersonalProjectLibrary (faculties/wiki/personal-projects.ts:241,623).
// The wiki is cut (a no-op stage), so the lane names this structural port and
// the Lite composition root passes the empty library
// (EMPTY_PERSONAL_PROJECTS). Declarations copied verbatim from the donor at
// e6a9546: faculties/wiki/personal-project-contracts.ts:8,13,28-31,43-46.

export type PersonalProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

/** Publication/review mode for a publication work context (bible §10.9/§10.10). */
export type ProjectPublicationMode = 'public_clean' | 'expressive_review';

export interface ProjectContactDmTarget {
  contactId: string;
  channelId?: string;
}

export type PersonalProjectWorkContext =
  | { kind: 'private'; returnTarget?: ProjectContactDmTarget }
  | { kind: 'room'; channelId: string }
  | { kind: 'publication'; mode: ProjectPublicationMode; surfaceRef?: string };

/** The manifest fields the free-time lane reads (a subset of PersonalProjectManifest). */
export interface PersonalProjectSummary {
  ref: string;
  title: string;
  status: PersonalProjectStatus;
  workContext: PersonalProjectWorkContext;
  nextStep: string;
}

export interface PersonalProjectsPort {
  listProjects(): readonly PersonalProjectSummary[];
  resumeNextActiveProject(): Promise<{ context: string } | null>;
}

/** No personal projects: the donor library over an empty wiki. */
export const EMPTY_PERSONAL_PROJECTS: PersonalProjectsPort = Object.freeze({
  listProjects: () => [],
  resumeNextActiveProject: async () => null,
});
