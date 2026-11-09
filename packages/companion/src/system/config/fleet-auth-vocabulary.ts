// Lite seam S8 (docs/extraction.md, "S8: the light Garden"): moved verbatim
// from donor src/system/config/fleet-auth-config.ts at e6a9546 (lines 57-58 and
// 99-173). The kept Garden route authorization catalogue
// (boundary/fleet-auth/garden-route-authorization.ts, role-action-policy.ts)
// classifies every Garden route by this closed action vocabulary; the rest of
// fleet-auth-config.ts (the fleet auth owner-file loader) is cut with fleet auth.

export const FLEET_AUTH_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export type FleetAuthRole = typeof FLEET_AUTH_ROLES[number];

/**
 * Stable action vocabulary accepted by the persistence/config substrate.
 * Role evaluation is implemented by opl1.5; this owner file can only disable
 * members of this closed vocabulary and therefore cannot widen that policy.
 */
export const FLEET_AUTH_ACTIONS = [
  'public.read',
  'legacy_session.manage',
  'recovery.begin',
  'companion.read',
  'companion.interact',
  'embodiment.handoff',
  'garden.read',
  'action_pipe.read',
  'action_pipe.manage',
  'audit.read',
  'automata.read',
  'automata.manage',
  'autonomy.read',
  'autonomy.manage',
  'charges.read',
  'channels.read',
  'channels.manage',
  'cogsec.read',
  'cogsec.manage',
  'confirmations.read',
  'confirmations.resolve',
  'confirmations.manage',
  'artifacts.read',
  'contact_approvals.read',
  'contact_approvals.manage',
  'contacts.read',
  'contacts.manage',
  'contacts.bind',
  'devices.read',
  'settings.read',
  'settings.write',
  'diagnostics.read',
  'graph.read',
  'graph.manage',
  'identity.read',
  'identity.manage',
  'images.read',
  'images.manage',
  'memory.read',
  'memory.manage',
  'models.read',
  'models.manage',
  'places.read',
  'places.manage',
  'prompts.read',
  'prompts.manage',
  'scheduler.read',
  'scheduler.manage',
  'sessions.read',
  'sessions.repair',
  'shared_workspace.read',
  'shared_workspace.manage',
  'skills.read',
  'skills.manage',
  'telemetry.read',
  'tool_activity.read',
  'tools.read',
  'tools.execute',
  'values.read',
  'wiki.read',
  'wiki.manage',
  'roles.manage',
  'memory.read.self',
  'memory.reveal',
  'privacy.break_glass',
  'devices.manage',
  'provider.link',
] as const;
export type FleetAuthAction = typeof FLEET_AUTH_ACTIONS[number];
