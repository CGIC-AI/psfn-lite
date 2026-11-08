// ── API health snapshot shape ──
//
// Lite extraction (seam 3.12, channels cut). The substrate agent's optional
// health context (`CompanionSubstrateHealthContext.apiHealth`,
// runtime-context.ts) carries the donor API server's health snapshot; a host
// sets it through setCompanionSubstrateHealthContext or leaves it null. The
// API server that produces it is not core.
//
// Copied verbatim from the donor's src/channels/api/types.ts at e6a9546
// (lines 161-199; ApiHealthSubsystem and ApiContinuityWatchdogCheck are derived
// from the two const lists, so those are copied as values).

export const API_HEALTH_SUBSYSTEMS = [
  'memory',
  'llm',
  'discord',
  'embeddings',
  'scheduler',
] as const;

export const API_CONTINUITY_WATCHDOG_CHECKS = [
  'database',
  'gatewayLink',
  'schedulerHealthcheck',
] as const;

export type ApiHealthState = 'healthy' | 'degraded';
export type ApiHealthSubsystem = (typeof API_HEALTH_SUBSYSTEMS)[number];
export type ApiContinuityWatchdogCheck = (typeof API_CONTINUITY_WATCHDOG_CHECKS)[number];

export interface ApiHealthSubsystemStatus {
  status: ApiHealthState;
  detail?: string;
  meta?: Record<string, unknown>;
}

export type ApiServerHealthChecks = Partial<Record<
  ApiHealthSubsystem,
  () => Promise<ApiHealthSubsystemStatus> | ApiHealthSubsystemStatus
>>;

export interface ApiHealthResponse {
  status: ApiHealthState;
  checkedAt: string;
  uptimeSeconds: number;
  subsystems: Record<ApiHealthSubsystem, ApiHealthSubsystemStatus>;
  continuity: {
    status: ApiHealthState;
    checks: Record<ApiContinuityWatchdogCheck, ApiHealthSubsystemStatus>;
  };
}
