// ── Fleet-ordinal stagger ──
//
// Lite extraction (seam 3.9, fleet cut). The scheduler spreads shared
// wall-clock slots, free-time poll phases and the quiet-hours release by a
// companion's manifest position when a host passes a FleetSlotStagger
// (scheduler.json `fleetStagger`; ScheduledTask.fleetStagger,
// FreeTimeRuntimeOptions.fleetStagger, ReflectionRuntimeOptions.fleetScheduleStagger).
// The donor keeps that pure arithmetic in core/scheduler/fleet-maintenance-coordinator.ts
// beside the cross-companion maintenance lease, which is not core. Only the
// arithmetic moves here; every call site already skips it when no stagger is
// passed, and ordinal 0 of a fleet of 1 returns windowStartMs (no offset).
//
// Moved verbatim from the donor's src/core/scheduler/fleet-maintenance-coordinator.ts
// at e6a9546: requireTimestamp (lines 20-25) and staggerFleetOrdinalWithinWindow
// (lines 342-363).
import type { FleetOrdinalStagger } from './types.js';

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

export function staggerFleetOrdinalWithinWindow(
  input: FleetOrdinalStagger & { windowStartMs: number; windowEndMs: number },
): number {
  const windowStartMs = requireTimestamp(input.windowStartMs, 'fleetSchedule.windowStartMs');
  const windowEndMs = requireTimestamp(input.windowEndMs, 'fleetSchedule.windowEndMs');
  if (windowEndMs <= windowStartMs) {
    throw new Error('fleetSchedule.windowEndMs must be greater than windowStartMs');
  }
  if (!Number.isSafeInteger(input.fleetSize) || input.fleetSize < 1) {
    throw new Error('fleetSchedule.fleetSize must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(input.manifestOrdinal)
    || input.manifestOrdinal < 0
    || input.manifestOrdinal >= input.fleetSize
  ) {
    throw new Error('fleetSchedule.manifestOrdinal must identify a fleet member');
  }
  return windowStartMs + Math.floor(
    ((windowEndMs - windowStartMs) * input.manifestOrdinal) / input.fleetSize,
  );
}
