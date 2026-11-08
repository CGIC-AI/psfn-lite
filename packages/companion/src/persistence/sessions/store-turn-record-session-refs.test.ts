import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEntry } from '../../core/session/types.js';
import { buildContinuityEntryMetadata } from '../../core/session/continuity-provenance.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createTurnId } from '../../core/turns/id.js';
import { SessionStore } from './store.js';
import {
  REDACTED_MESSAGE_PLACEHOLDER,
  WITHHELD_WIRE_BODY_MARKER,
} from './turn-record-session-refs.js';
import {
  AdminSessionTurnObservabilityStore,
  buildPromptLoomData,
} from '../../operator/garden/services/session-turn-observability.js';
import type { AdminTurnSnapshotData } from '../../operator/garden/services/types.js';
import { EventBus } from '../../shared/event-bus.js';
import { createTurnRecordIntrospectionSource } from '../../faculties/introspection/source.js';
import { CogSecEventStore } from '../../core/cogsec/events.js';
import { CogSecForensicArchive } from '../../core/cogsec/forensic-archive.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
} from '../layout.js';

/** Persist a record with its verbatim inline recentEntries intact (no ref) — the
 * exact pre-9ree "old fat" on-disk shape — by bypassing the session-entry slim
 * that SessionStore.appendTurnRecord normally applies. */
function appendFatTurnRecord(store: SessionStore, record: TurnRecord): void {
  (store as unknown as {
    turnRecordStore: { appendTurnRecord(record: TurnRecord): void };
  }).turnRecordStore.appendTurnRecord(record);
}

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-9ree-'));
  dirs.push(dir);
  return dir;
}

function readTurnRecordFile(dir: string): string {
  const turnDir = join(dir, '_turn_records');
  const files = readdirSync(turnDir).filter(name => name.endsWith('.jsonl'));
  return files.map(name => readFileSync(join(turnDir, name), 'utf8')).join('\n');
}

function message(entry: SessionEntry): Record<string, unknown> {
  return { role: entry.role, content: entry.content, provenance: { sourceEntryIds: [entry.id] } };
}

function buildTurnRecord(
  channelId: string,
  recentEntries: SessionEntry[],
  messages: Array<Record<string, unknown>>,
): TurnRecord {
  const turnId = createTurnId();
  return {
    schemaVersion: 1,
    turnId,
    requestId: `req-${turnId}`,
    channelId,
    channelType: 'api',
    startedAt: 1,
    completedAt: 2,
    status: 'completed',
    userMessage: { role: 'user', content: 'x', timestamp: 1 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test/model' },
    provenanceRefs: [],
    observability: {
      stages: [],
      retrievals: [],
      snapshot: {
        turnId,
        requestId: `req-${turnId}`,
        channelId,
        capturedAt: 1,
        trustLevel: 'regular',
        sessionContext: {
          channelId,
          recentEntries,
          compactionSummaryTexts: [],
          focusKnowledgeTexts: [],
          continuityEntries: [],
          versionPointer: 'test/session',
        },
        plan: {
          schemaVersion: 1,
          blocks: [],
          variables: {},
          messages,
          toolDefinitions: [],
          cachePlan: { staticBoundary: 0, sessionStableBoundary: 0 },
          scope: {},
        },
      },
    },
  } as unknown as TurnRecord;
}

describe('SessionStore turn-record session-entry diet (psfn-framework-9ree)', () => {
  it('reads tool-usage metadata without resolving old-fat session context', () => {
    const dir = makeDir();
    const channelId = 'api:usage-projection';
    const turnId = createTurnId();
    const readRecentTurnRecords = vi.fn(() => {
      throw new Error('full TurnRecord read must not run for usage aggregation');
    });
    const readRecentTurnRecordUsage = vi.fn(() => [{
      turnId,
      startedAt: 1,
      toolCalls: [{
        toolName: 'repo',
        outcome: 'success' as const,
      }],
    }]);
    const turnRecordStore = {
      appendTurnRecord: vi.fn(),
      readRecentTurnRecords,
      readRecentTurnRecordUsage,
      findTurnRecord: vi.fn(() => null),
    } as unknown as TurnRecordStorePort;
    const store = new SessionStore(dir, { turnRecordStore });

    const usage = (store as unknown as {
      getRecentTurnRecordUsage(
        sourceChannelId: string,
        limit: number,
      ): ReturnType<typeof readRecentTurnRecordUsage>;
    }).getRecentTurnRecordUsage(channelId, 32);

    expect(usage).toEqual(readRecentTurnRecordUsage());
    expect(readRecentTurnRecordUsage).toHaveBeenCalledWith(channelId, 32);
    expect(readRecentTurnRecords).not.toHaveBeenCalled();
  });

  it('erases the verbatim recentEntries copy from disk and reconstructs it from L0 on read', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:diet';
    store.append({ channelId, role: 'user', content: 'first partner line', timestamp: 1_000 });
    store.append({ channelId, role: 'assistant', content: 'first companion line', timestamp: 2_000 });
    store.append({ channelId, role: 'user', content: 'second partner line', timestamp: 3_000 });
    const entries = store.getRecent(channelId, 10);
    expect(entries).toHaveLength(3);

    // No plan.messages here so the ONLY copy of the bodies is recentEntries;
    // proving they vanish from the turn-record file proves the dedup.
    const record = buildTurnRecord(channelId, entries, []);
    void store.appendTurnRecord(record);

    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('recentEntriesRef');
    expect(persisted).not.toContain('first partner line');
    expect(persisted).not.toContain('first companion line');
    expect(persisted).not.toContain('second partner line');

    // On read: reconstructed transparently from the journal.
    const read = store.getRecentTurnRecords(channelId, 10);
    expect(read).toHaveLength(1);
    const ctx = (read[0]!.observability!.snapshot as unknown as { sessionContext: { recentEntries: SessionEntry[] } }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual([
      'first partner line',
      'first companion line',
      'second partner line',
    ]);
    expect((ctx as unknown as Record<string, unknown>).recentEntriesRef).toBeUndefined();
  });

  it('never resurrects an entry that is gone from L0, and masks its rendered message', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:gone';
    store.append({ channelId, role: 'user', content: 'kept line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // Reference a phantom entry (id absent from L0) carrying sensitive text.
    const phantom: SessionEntry = { id: 9_999, channelId, role: 'user', content: 'REDACTED SECRET', timestamp: 4_000 };
    const captured = [...entries, phantom];
    const record = buildTurnRecord(channelId, captured, captured.map(message));
    void store.appendTurnRecord(record);

    // recentEntries never carries the phantom body verbatim — only its id.
    const persisted = readTurnRecordFile(dir);
    expect(persisted).toContain('"recentEntriesRef"');
    expect(persisted).toContain('9999');

    const read = store.getRecentTurnRecords(channelId, 10);
    const snapshot = read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[] };
      plan: { messages: Array<{ content: string }> };
    };
    // recentEntries drops the unresolvable phantom; the kept entry survives.
    expect(snapshot.sessionContext.recentEntries.map(e => e.content)).toEqual(['kept line']);
    // The rendered view masks the phantom-backed message and keeps the live one.
    expect(snapshot.plan.messages.map(m => m.content)).toEqual(['kept line', REDACTED_MESSAGE_PLACEHOLDER]);
    expect(JSON.stringify(read)).not.toContain('REDACTED SECRET');
  });

  // ── pre-9ree "old fat" record gating (bead psfn-framework-hgw3.10) ──────────

  it('heals a pre-9ree fat record whose inline L0 entry is now gone, never resurrecting its body', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:oldfat-gone';
    store.append({ channelId, role: 'user', content: 'live line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    // A captured entry whose id is absent from L0 (redacted-as-tombstone / rolled off).
    const phantom: SessionEntry = { id: 9_999, channelId, role: 'user', content: 'PHANTOM SECRET body', timestamp: 4_000 };

    appendFatTurnRecord(store, buildTurnRecord(channelId, [...entries, phantom], []));

    // Genuinely fat on disk: the phantom body is present verbatim (the leak).
    const persisted = readTurnRecordFile(dir);
    expect(persisted).not.toContain('recentEntriesRef');
    expect(persisted).toContain('PHANTOM SECRET body');

    const read = store.getRecentTurnRecords(channelId, 10);
    const ctx = (read[0]!.observability!.snapshot as unknown as {
      sessionContext: { recentEntries: SessionEntry[] };
    }).sessionContext;
    expect(ctx.recentEntries.map(e => e.content)).toEqual(['live line']);
    expect(JSON.stringify(read)).not.toContain('PHANTOM SECRET body');
  });
});

// ── captured wire-body CogSec gating (bead psfn-framework-eb14) ────────────────

/** Build a turn record whose snapshot carries a captured provider wire body
 * (the shape 80f6 interns into `_shared/wirebodies`). The body embeds the
 * verbatim partner/companion lines the provider request actually shipped. */
function buildWireTurnRecord(
  channelId: string,
  recentEntries: SessionEntry[],
  messages: Array<Record<string, unknown>>,
  wireBody: unknown,
  options?: {
    /**
     * The current turn's own partner L0 entry id — persisted at
     * `userMessage.sessionEntryId`. Production EXCLUDES this entry from both
     * `recentEntries` and `plan.messages` (prompt-assembly throws if it leaks
     * into prior history), yet its plaintext IS the wire body's final user
     * message. Set this to reproduce the production shape where the tombstone
     * target is the current turn itself (bead psfn-framework-eb14, blocker 1).
     */
    currentTurnPartnerEntryId?: number;
    /** The wire body's final user message text (= the current partner line). */
    currentTurnInput?: string;
  },
): TurnRecord {
  const record = buildTurnRecord(channelId, recentEntries, messages);
  const snapshot = record.observability!.snapshot! as unknown as Record<string, unknown>;
  // Give the plan an (empty) blocks array so the Loom system-section derivation
  // has something to iterate; the raw-wire panel we assert on is independent.
  snapshot.plan = {
    schemaVersion: 1,
    messages,
    blocks: [],
    variables: {},
    toolDefinitions: [],
    cachePlan: { staticBoundary: 0, sessionStableBoundary: 0 },
    scope: {},
  };
  if (options?.currentTurnPartnerEntryId !== undefined) {
    (record.userMessage as { sessionEntryId?: number; content: string }).sessionEntryId
      = options.currentTurnPartnerEntryId;
    if (options.currentTurnInput !== undefined) {
      (record.userMessage as { content: string }).content = options.currentTurnInput;
    }
  }
  snapshot.promptContext = {
    currentTurnInput: options?.currentTurnInput ?? 'wire input',
    providerObservability: {
      routeKind: 'registered_model',
      requestedProvider: 'fixture',
      requestedModel: 'fixture',
      backendProvider: 'fixture',
      backendModel: 'fixture',
      backendApi: 'anthropic-messages',
      // transport null ⇒ Loom uses the recorded_snapshot branch (no full plan
      // serialization needed) while still surfacing capturedWirePayload.
      systemRole: {
        transport: null,
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: false,
      },
      promptCaching: { configured: false, engaged: false },
      capturedWirePayload: {
        api: 'anthropic-messages',
        model: 'test/model',
        capturedAtMs: 1_700_000_000_000,
        byteLength: Buffer.byteLength(JSON.stringify(wireBody), 'utf8'),
        toolCount: 0,
        body: wireBody,
      },
    },
  };
  return record;
}

function capturedBody(record: TurnRecord): unknown {
  const snapshot = record.observability!.snapshot as unknown as {
    promptContext?: { providerObservability?: { capturedWirePayload?: { body?: unknown } } };
  };
  return snapshot.promptContext?.providerObservability?.capturedWirePayload?.body;
}

describe('SessionStore captured wire-body CogSec gating (psfn-framework-eb14)', () => {
  // HISTORY-redaction path: a PRIOR-turn partner entry (present in plan.messages
  // with provenance, the production shape for history) is tombstoned. This
  // exercises the plan.messages-suppression withhold key. The CURRENT-turn entry
  // path — the entry plan.messages structurally excludes — is covered by the
  // dedicated regression below (blocker 1); this test deliberately does NOT stand
  // in for it.

  // ── blocker 1: the CURRENT turn's own partner entry ─────────────────────────
  // Production shape: the current-turn partner entry is EXCLUDED from both
  // recentEntries and plan.messages, yet its plaintext is the wire body's final
  // user message. Before the fix, tombstoning it left NO plan.messages provenance
  // signal, so the body served the redacted plaintext verbatim. The fix keys the
  // withhold on userMessage.sessionEntryId directly.

  // ── blocker 1: empty plan.messages must not skip the wire-body gate ──────────
  // Before the fix, gateRenderedViews early-returned when plan.messages was empty,
  // leaving a present wire body ungated. Here plan.messages is empty but the
  // recentEntries window (and the wire body) embed a partner entry that is later
  // tombstoned; the body must still be withheld.

  it('serves the captured wire body verbatim while all embedded L0 entries remain live', () => {
    const dir = makeDir();
    const store = new SessionStore(dir);
    const channelId = 'api:wire-live';
    store.append({ channelId, role: 'user', content: 'ordinary partner line', timestamp: 1_000 });
    const entries = store.getRecent(channelId, 10);
    const wireBody = { model: 'test/model', messages: entries.map(e => ({ role: e.role, content: e.content })) };
    void store.appendTurnRecord(buildWireTurnRecord(channelId, entries, entries.map(message), wireBody));

    const read = store.getRecentTurnRecords(channelId, 10);
    // No redaction ⇒ byte-identical body, no withhold marker.
    expect(JSON.stringify(capturedBody(read[0]!))).toContain('ordinary partner line');
    expect(JSON.stringify(read)).not.toContain(WITHHELD_WIRE_BODY_MARKER);
  });
});
