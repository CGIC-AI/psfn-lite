/**
 * The Garden audit trail: the donor's Garden audit entries, written to the
 * same file with the same record shape. This is a port of the donor's
 * `AdminAuditHistoryDataService.appendGardenEntry`
 * (operator/garden/services/audit-history-service.ts:269-293) and of its
 * JSONL store's `append` (:120-127) and `toAuditRequestAttribution`
 * (:385-405). The rest of that service (the history reader, which also reads
 * the gateway audit port and the charge ledger) is cut with those screens.
 * Every Garden write the donor audited records actor `operator`, as the
 * donor's composition passed it (local-admin-contract.ts:779-797, 1060-1074).
 */
import { join } from 'node:path';
import {
  appendJsonLine,
  type AdminAuditActionType,
  type AdminAuditActor,
  type AdminAuditDecision,
  type AdminAuditHistoryEntry,
  type AdminAuditRequestAttribution,
  type GardenRequestContext,
} from './companion.ts';

/** The donor's file name under the companion data directory (local-admin-contract.ts:458). */
export const GARDEN_AUDIT_FILE = 'garden-audit-history.jsonl';
/** The donor's record schema version (audit-history-service.ts:36). */
const GARDEN_AUDIT_SCHEMA_VERSION = 1;

export interface GardenAuditInput {
  readonly actionType: AdminAuditActionType;
  readonly decision: AdminAuditDecision;
  readonly narrative: string;
  readonly details?: string;
  readonly actor?: AdminAuditActor;
  readonly requestContext?: GardenRequestContext;
}

export class GardenAudit {
  private counter = 0;
  readonly path: string;

  constructor(companionDataDir: string, private readonly now: () => number = Date.now) {
    this.path = join(companionDataDir, GARDEN_AUDIT_FILE);
  }

  append(input: GardenAuditInput): AdminAuditHistoryEntry {
    const timestamp = this.now();
    this.counter += 1;
    const details = input.details?.trim();
    const entry: AdminAuditHistoryEntry = {
      id: `garden-audit-${timestamp}-${this.counter}`,
      timestamp,
      source: 'garden',
      sourceRecordId: `garden:${timestamp}:${this.counter}`,
      actionType: input.actionType,
      decision: input.decision,
      narrative: input.narrative,
      ...(details ? { details } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.requestContext ? { requestAttribution: requestAttribution(input.requestContext) } : {}),
    };
    appendJsonLine(this.path, { schemaVersion: GARDEN_AUDIT_SCHEMA_VERSION, recordType: 'garden_audit_history', entry });
    return entry;
  }

  /** The donor's timeline appender shape, with the details joined as the donor joined them (local-admin-contract.ts:780-783). */
  appender(actor: AdminAuditActor = 'operator') {
    return (
      actionType: AdminAuditActionType,
      decision: AdminAuditDecision,
      narrative: string,
      details?: Array<string | null | undefined>,
      requestContext?: GardenRequestContext,
    ): void => {
      const joined = details?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0).join(' ');
      this.append({ actionType, decision, narrative, ...(joined ? { details: joined } : {}), actor, ...(requestContext ? { requestContext } : {}) });
    };
  }
}

/** The donor route builders' appender (server-routes.ts:102-122): the actor is the one the route names. */
export function routeAppender(audit: GardenAudit) {
  return (
    actionType: AdminAuditActionType,
    decision: AdminAuditDecision,
    narrative: string,
    details?: Array<string | null | undefined>,
    actor?: AdminAuditActor,
    requestContext?: GardenRequestContext,
  ): void => {
    const joined = details?.filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0).join(' ');
    audit.append({ actionType, decision, narrative, ...(joined ? { details: joined } : {}), ...(actor ? { actor } : {}), ...(requestContext ? { requestContext } : {}) });
  };
}

function requestAttribution(context: GardenRequestContext): AdminAuditRequestAttribution {
  return Object.freeze({
    actor: context.kind === 'fleet_principal'
      ? Object.freeze({ kind: context.actor.kind, principalId: context.actor.principalId, contactId: context.actor.contactId, role: context.actor.role })
      : Object.freeze({ kind: context.actor.kind }),
    companionId: context.resource.companionId,
    requestId: context.requestId,
    decisionId: context.decisionId,
    action: context.action,
    routeId: context.resource.routeId,
    resourceScope: context.resource.scope,
    resourceArea: context.resource.area,
    subjectRelation: context.subjectRelation,
    authorityVersions: context.versions ? Object.freeze({ ...context.versions }) : null,
  });
}
