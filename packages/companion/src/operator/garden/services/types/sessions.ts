import type { SessionEntry } from '../../../../core/session/types.js';
import type {
  SessionRouteResetMode,
  SourceChannelSessionRoute,
} from '../../../../core/session/session-routes.js';
import type { TurnRecord } from '../../../../shared/contracts/runtime.js';
import type {
  ChannelInfo,
  CompactionAuditView,
} from '../../types.js';
import type { MessageClass } from '../../../../core/agent/message-classes.js';
import type {
  AdminTurnStageTelemetry,
  AdminTurnRetrievalTelemetry,
  AdminTurnSnapshotData,
  AdminPromptLoomData,
} from './prompt-loom.js';
import type {
  AdminSessionRoleEnvelopePreview,
  AdminContinuityProvenanceView,
} from './continuity.js';
import type { GardenRequestContext } from '../../garden-request-context.js';

export type AdminSessionListRow = Pick<
  ChannelInfo,
  'sessionId' | 'channelId' | 'messageCount' | 'lastActivityAt' | 'displayLabel'
>;

export interface AdminSessionListData {
  channels: AdminSessionListRow[];
}

export interface AdminSessionDetailData {
  channel: AdminSessionListRow & Pick<ChannelInfo, 'linkedContactId' | 'linkedContactName'>;
}

export type AdminSessionRouteView = SourceChannelSessionRoute;

export interface AdminSessionRouteListData {
  routes: AdminSessionRouteView[];
  channels: AdminSessionListRow[];
}

export interface AdminSessionRouteResetInput {
  sourceChannelId: string;
  reason: string;
  actor?: string;
  mode?: SessionRouteResetMode;
}

export interface AdminSessionRouteResetData {
  ok: boolean;
  message: string;
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  route: AdminSessionRouteView;
  retiredSession: SourceChannelSessionRoute['retiredSessions'][number];
}

export interface AdminSessionMessageOntologyView {
  sessionEntryId: number;
  transportRole: SessionEntry['role'];
  promptRole: 'user' | 'assistant' | 'toolResult' | 'custom';
  semanticType: 'outwardSpeech' | 'toolResult' | 'systemNote' | 'mirror' | 'letter';
  messageClass: MessageClass | null;
  promptVisibility: 'prompt_visible' | 'operator_only';
  displayLabel: string;
}

export interface AdminSessionMessagesData {
  sessionId: string;
  channelId: string;
  messages: SessionEntry[];
  pagination: AdminSessionMessagePaginationData;
  messageOntologyViews: AdminSessionMessageOntologyView[];
  roleEnvelopePreviews: AdminSessionRoleEnvelopePreview[];
  compactionAuditViews: CompactionAuditView[];
  turns: AdminSessionTurnData[];
}

export interface AdminSessionMessagePaginationOptions {
  limit?: number;
  beforeId?: number | null;
  /**
   * Skip turn snapshots, compaction audit verification, and role-envelope
   * previews. Used by pickers (e.g. CogSec row selection) so huge sessions
   * page cheaply.
   */
  messagesOnly?: boolean;
  /**
   * Skip the up-to-50 full turn snapshots and role-envelope previews while
   * still returning compaction audit views. Defaults to true (turns included)
   * for backward compatibility with the prompt-monitor/Loom fetch. The session
   * browser sends `false` so its initial page carries messages, ontology, and
   * compaction summaries without the multi-MB turn payload; individual turn
   * detail is fetched lazily via `getSessionTurnDetail`.
   */
  includeTurns?: boolean;
}

export interface AdminSessionSearchHitView {
  messageId: number;
  role: SessionEntry['role'];
  authorId?: string;
  authorName?: string;
  content: string;
  timestamp: number;
  snippet: string;
}

export interface AdminSessionSearchData {
  sessionId: string;
  query: string;
  limit: number;
  hits: AdminSessionSearchHitView[];
}

export interface AdminSessionMessagePaginationData {
  limit: number;
  beforeId: number | null;
  nextBeforeId: number | null;
  hasMoreOlder: boolean;
  totalMessages: number;
  returnedMessages: number;
}

export interface AdminSessionTurnDetailData {
  sessionId: string;
  channelId: string;
  turn: AdminSessionTurnData;
}

export interface AdminSessionService {
  listSessions(context?: GardenRequestContext): Promise<AdminSessionListData>;
  getSessionDetail(sessionId: string, context?: GardenRequestContext): Promise<AdminSessionDetailData>;
  /**
   * Garden transport read path. The newest page may use the optional shared
   * session tail; older cursor pages stay on the canonical bounded reader.
   */
  getSessionMessagesForAdminRead(
    sessionId: string,
    options?: AdminSessionMessagePaginationOptions,
    context?: GardenRequestContext,
  ): Promise<AdminSessionMessagesData>;
  /**
   * Canonical reader used by non-transport callers and fallback. Async because
   * it resolves persisted retrieved-memory candidate refs against the live
   * memory store at read time (bead psfn-framework-jsi9).
   */
  getSessionMessages(sessionId: string, options?: AdminSessionMessagePaginationOptions, context?: GardenRequestContext): Promise<AdminSessionMessagesData>;
  getSessionTurnDetail(sessionId: string, turnId: string, context?: GardenRequestContext): Promise<AdminSessionTurnDetailData>;
  searchSessionMessages(sessionId: string, query: string, limit?: number, context?: GardenRequestContext): Promise<AdminSessionSearchData>;
  listSessionRoutes(context?: GardenRequestContext): Promise<AdminSessionRouteListData>;
  resetSourceChannelSession(input: AdminSessionRouteResetInput, context?: GardenRequestContext): Promise<AdminSessionRouteResetData>;
}

export interface AdminSessionTurnData {
  record: TurnRecord;
  roleEnvelopeRefs: string[];
  continuityProvenance: AdminContinuityProvenanceView[];
  stages: AdminTurnStageTelemetry[];
  retrievals: AdminTurnRetrievalTelemetry[];
  snapshot: AdminTurnSnapshotData | null;
  promptLoom?: AdminPromptLoomData;
}
