/**
 * What the Garden screens read and write, through the plugin's dashboard
 * backend (`psfn_lite/dashboard/plugin_api.py`) to Lite's Garden. Each type
 * names only the fields a screen shows; the routes answer more. The donor
 * Garden routes are under `/api/admin`, the Lite routes under `/api/lite`
 * (packages/operator/src/lite-routes.ts).
 */

export interface RestOptions {
  method?: string;
  body?: unknown;
}

/** `ctx.rest`: a path relative to `/api/plugins/psfn_lite`. */
export type Rest = <T>(path: string, options?: RestOptions) => Promise<T>;

export interface Garden {
  readonly rest: Rest;
  readonly navigate: (path: string) => void;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SessionRow {
  sessionId: string;
  channelId: string;
  messageCount: number;
  lastActivityAt: number;
}

/** The donor's session list (AdminSessionListData, packages/companion/src/operator/garden/services/types/sessions.ts:29). */
export interface SessionList {
  channels: SessionRow[];
}

export interface Turn {
  role: string;
  content: string;
  authorName?: string;
  timestamp: number;
}

export interface SchedulerTask {
  id: string;
  name: string;
  state: string;
  intervalMs?: number;
  lastRunAt?: number;
  lastOutcome?: string;
}

export interface Reflection {
  id: string;
  name: string;
  enabled: boolean;
  mode?: string;
}

export interface Emotion {
  vad: { valence: number; arousal: number; dominance: number };
  mood: { valence: number; arousal: number; dominance: number };
  discrete: Record<string, number>;
  confidence: number;
}

export interface Overview {
  companionId: string;
  model: { provider: string; modelId: string };
  tier: { tier: string };
  restartRequired: boolean;
  heartbeat: { tasks: SchedulerTask[]; reflections: Reflection[] };
  openConcerns: Concern[];
  latestSession: SessionRow | null;
  recentTurns: Turn[];
  focus: FocusSnapshot[];
  emotion: Emotion | null;
}

export interface Memory {
  id: string;
  text: string;
  type: string;
  importance: number;
  sensitivity: string;
  extractedAt: number;
  tags?: string[];
}

export interface MemoryPage {
  memories: Memory[];
  withheldBySubjectAuthorizationCount?: number;
  pagination: { total: number };
}

export interface MemorySearch {
  results: Memory[];
}

export interface MemoryDetail {
  memory: Memory & {
    confidence?: number;
    sourceType?: string;
    scopeTags?: string[];
    provenance?: { toolName?: string; sessionId?: string };
  };
}

export interface DeletionProposal {
  id: string;
  memoryId: string;
  justificationCategory: string;
  explanation: string;
  status: string;
  proposedAt: number;
  awaitingHostTurn?: boolean;
  deleteId?: string;
}

export interface MemoryDeletions {
  pending: DeletionProposal[];
  recoverable: DeletionProposal[];
}

export interface Deleted {
  memoryId: string;
  deleteId: string;
}

export const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const;
export type CardField = (typeof CARD_FIELDS)[number];

export interface HistoryEntry {
  version: number;
  timestamp: string;
  updatedBy: string;
  reason?: string;
}

export interface Identity {
  card: { data: Record<CardField, string> };
  version: number;
  history: HistoryEntry[];
}

export interface PromptLayer {
  id: string;
  /** `operator` layers are written only by an operator principal (canWriteOperatorLayers). */
  type: string;
  name: string;
  identifier: string;
  enabled: boolean;
  version: number;
  updatedAt: string;
  content: string;
}

export interface Prompts {
  layers: PromptLayer[];
  canWriteOperatorLayers: boolean;
}

export interface LayerDetail {
  layer?: PromptLayer;
  layerHistory?: HistoryEntry[];
}

/** The constitution snapshot: the companion-derived values layer is read-only. */
export interface Constitution {
  companionLayer: { title: string; content: string } | null;
}

export interface NorthStar {
  items: { id: string; title: string; content: string; enabled: boolean; scope: string }[];
  preview: { text: string };
}

export interface LayerDiff {
  oldContent: string;
  newContent: string;
}

export interface Contact {
  id: string;
  displayName: string;
  trustLevel: string;
  relationshipType: string;
  lastSeen: string;
}

export interface BiographicalClaim {
  id: string;
  kind: string;
  status: string;
  derivation?: string;
}

export interface GraphProposal {
  id: string;
  sourceDisplayName: string;
  targetDisplayName: string;
  relationshipType: string;
  status: string;
  rationale: string;
}

export interface Concern {
  id: string;
  text: string;
  priority: string;
  status: string;
  createdAt: string;
}

export interface FocusSnapshot {
  focusId: string;
  channelId: string;
  scope: string;
  startedAt: number;
}

export interface InnerLife {
  focus: FocusSnapshot[];
  emotion: Emotion | null;
  introspectionConsent: { status: string; enabled: boolean };
  wakeWindow: { timingMode: string; source: string; timeZone: string; effective: { localTime: string } } | null;
}

export interface AutomatonClass {
  id: string;
  workerKind: string;
  trigger: string;
  busEligibility: string;
}

export interface AutomatonCoverage {
  automatonClass: string;
  health: string;
  runs: { total: number; active: number; failed: number };
}

export interface AutomatonRun {
  runId: string;
  automatonClass: string;
  taskLabel?: string;
  status: string;
}

export interface Automata {
  classes: AutomatonClass[];
  coverage: { available: boolean; classes: AutomatonCoverage[] } | null;
  runs: AutomatonRun[];
  bus: { available: boolean; health?: { condition: string; freshness: string }; events: BusEvent[] } | null;
}

export const CONCERN_STATUSES = ['candidate', 'active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'] as const;

export interface TurnRecord {
  turnId: string;
  startedAt: number;
  status: string;
  userMessage?: { content: string };
  assistantMessage?: { content: string };
  toolCalls: { toolName: string; outcome?: string }[];
  extractedMemoryIds: string[];
  versionPointers?: { model?: string; promptMode?: string; promptHash?: string };
}

export interface SessionTurn {
  record: TurnRecord;
  retrievals: { count: number; purpose?: string; reason?: string; retrievalSource?: string }[];
}

export interface SessionMessages {
  messages: Turn[];
  turns: SessionTurn[];
}

export interface TurnDetail {
  turn: SessionTurn;
}

export interface BusEvent {
  eventId: string;
  type: string;
  sequence: number;
  occurredAt: string;
}

export const TIERS = ['nursery', 'apprentice', 'autonomous', 'custom'] as const;

export interface Settings {
  model: { provider: string; modelId: string };
  tier: { tier: string; customTokens: string[] };
  scheduler: Record<string, unknown>;
}

export interface SettingsSaved {
  restartRequired: boolean;
}

/** A memory id as the companion mints it (a UUID); a transcript directive's id is checked against it. */
export const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A prompt layer id: a plain path segment. */
export const LAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const path = {
  overview: '/api/lite/overview',
  memories: '/api/admin/memory',
  memorySearch: (query: string) => `/api/admin/memory/search?q=${encodeURIComponent(query)}`,
  memory: (id: string) => `/api/admin/memory/${encodeURIComponent(id)}`,
  patchMemory: (id: string) => `/api/admin/memory/${encodeURIComponent(id)}/patch`,
  memoryDeletions: '/api/lite/memory-deletions',
  deleteMemory: (id: string) => `/api/lite/memories/${encodeURIComponent(id)}/delete`,
  restoreMemory: '/api/lite/memories/restore',
  decideDeletion: (id: string, decision: 'approve' | 'reject') => `/api/lite/memory-deletions/${encodeURIComponent(id)}/${decision}`,
  identity: '/api/admin/identity',
  identityField: '/api/admin/identity/fields',
  identityRollback: '/api/admin/identity/rollback',
  prompts: '/api/admin/prompts',
  layer: (id: string) => `/api/admin/prompts/${encodeURIComponent(id)}`,
  layerDiff: (id: string) => `/api/admin/prompts/${encodeURIComponent(id)}/diff`,
  layerRollback: (id: string) => `/api/admin/prompts/${encodeURIComponent(id)}/rollback`,
  constitution: '/api/admin/prompts/constitution',
  northStar: '/api/admin/prompts/north-star',
  contacts: '/api/admin/contacts',
  claims: '/api/admin/biographical-claims',
  graphProposals: '/api/admin/graph-proposals',
  decideGraphProposal: (id: string, decision: 'approve' | 'reject') => `/api/admin/graph-proposals/${encodeURIComponent(id)}/${decision}`,
  sessions: '/api/admin/sessions',
  sessionMessages: (conversationKey: string) => `/api/admin/sessions/${encodeURIComponent(conversationKey)}?limit=50`,
  sessionTurn: (conversationKey: string, turnId: string) => `/api/admin/sessions/${encodeURIComponent(conversationKey)}/turns/${encodeURIComponent(turnId)}`,
  concerns: '/api/admin/concerns',
  resolveConcern: (id: string) => `/api/admin/concerns/${encodeURIComponent(id)}/resolve`,
  transitionConcern: (id: string) => `/api/admin/concerns/${encodeURIComponent(id)}/transition`,
  innerLife: '/api/lite/inner-life',
  /** Runs, the bus and its inspection (`busRunId` narrows the bus to one run), as the donor automata route serves them. */
  schedule: '/api/admin/scheduler',
  automata: (busRunId: string | null) => `/api/admin/automata?limit=20&busLimit=20${busRunId === null ? '' : `&busRunId=${encodeURIComponent(busRunId)}`}`,
  settings: '/api/lite/settings',
  tier: '/api/lite/settings/tier',
  scheduler: '/api/lite/settings/scheduler',
} as const;
