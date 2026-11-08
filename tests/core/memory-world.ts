/**
 * The continuity world plus the real memory, episode and journal stack, with
 * one dispatcher carrying both handler sets. Memory ports are pluggable so
 * the same world runs over the in-memory fakes and over the Postgres stores.
 */
import {
  TOOL_INVENTORY,
  createContinuityHandlers,
  createMemoryStack,
  createToolDispatcher,
  type EpisodeStorePort,
  type HostAttestation,
  type JournalNotePort,
  type LetterPort,
  type MemoryDeletionPort,
  type MemoryStorePort,
  type ReflectionPort,
  type ScratchpadPort,
  type SessionCursorPort,
  type TrustedTurnScope,
} from '../../packages/core/src/index.ts';
import { continuityWorld } from './continuity-world.ts';
import { PI, id } from './fakes.ts';
import {
  FakeCursors,
  FakeDeletions,
  FakeEmbeddings,
  FakeEpisodes,
  FakeJournal,
  FakeLetters,
  FakeMemoryStore,
  FakeReflections,
  FakeScratchpad,
  SPACE,
  ScriptedModel,
} from './memory-fakes.ts';

export interface MemoryPorts {
  readonly memories: MemoryStorePort;
  readonly deletions: MemoryDeletionPort;
  readonly scratchpad: ScratchpadPort;
  readonly extractionCursors: SessionCursorPort;
  readonly episodes: EpisodeStorePort;
  readonly formationCursors: SessionCursorPort;
  readonly journal: JournalNotePort;
  readonly reflections: ReflectionPort;
  readonly letters: LetterPort;
}

export function fakeMemoryPorts() {
  return {
    memories: new FakeMemoryStore(),
    deletions: new FakeDeletions(),
    scratchpad: new FakeScratchpad(),
    extractionCursors: new FakeCursors(),
    episodes: new FakeEpisodes(),
    formationCursors: new FakeCursors(),
    journal: new FakeJournal(),
    reflections: new FakeReflections(),
    letters: new FakeLetters(),
  };
}

export const ENDED_AFTER_MS = 30 * 60_000;

function group(externalId: string, channel: string): HostAttestation {
  return {
    surface: PI,
    principal: { kind: 'channel_account', identity: { channelKind: 'chat', externalId } },
    room: { kind: 'group', channelId: id<'channel'>(channel), room: 'small_group' },
    turnKind: 'foreground',
  };
}

export async function memoryWorld<P extends MemoryPorts>(memoryPorts: P) {
  const base = await continuityWorld();
  base.authenticator.tokens.set('friend-group', group('friend-handle', 'room-a'));
  base.authenticator.tokens.set('acq-group', group('acq-handle', 'room-a'));
  base.authenticator.tokens.set('primary-group', group('primary-handle', 'room-a'));
  base.authenticator.tokens.set('maintenance', {
    surface: PI,
    principal: { kind: 'companion_internal', purpose: 'maintenance' },
    room: { kind: 'self' },
    turnKind: 'background',
  });
  base.authenticator.tokens.set('reflection', {
    surface: PI,
    principal: { kind: 'companion_internal', purpose: 'reflection' },
    room: { kind: 'self' },
    turnKind: 'background',
  });
  const embeddings = new FakeEmbeddings();
  const model = new ScriptedModel();
  const stack = createMemoryStack({
    ...memoryPorts,
    contacts: base.contactStore,
    catalog: base.catalog,
    archive: base.archive,
    approvals: base.approvals,
    model,
    embedding: { port: embeddings, space: SPACE },
    clock: base.clock,
    ids: base.ids,
    endedAfterMs: ENDED_AFTER_MS,
  });
  if (!stack.ok) throw new Error(JSON.stringify(stack.error));
  const dispatcher = createToolDispatcher({
    inventory: TOOL_INVENTORY,
    handlers: {
      ...createContinuityHandlers({ sessions: base.sessions, contacts: base.contacts, orientation: base.orientation, values: base.values }),
      ...stack.value.handlers,
    },
  });
  if (!dispatcher.ok) throw new Error(JSON.stringify(dispatcher.error));
  const call = (scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}) =>
    dispatcher.value.dispatch(scope, { tool, action, args });
  /** The tool result content of a call that must succeed. */
  const must = async <T = unknown>(scope: TrustedTurnScope, tool: string, action: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await call(scope, tool, action, args);
    if (!result.ok) throw new Error(`${tool}.${action} failed: ${JSON.stringify(result.error)}`);
    return result.value.content as T;
  };
  // `journal` is the stack's journal service; the note port stays reachable as `journalNotes`.
  return { ...base, ...memoryPorts, ...stack.value, journalNotes: memoryPorts.journal as P['journal'], embeddings, model, dispatcher: dispatcher.value, call, must };
}

export const fakeMemoryWorld = () => memoryWorld(fakeMemoryPorts());

/** Result error kind, or 'ok'. */
export const kindOf = (result: { readonly ok: boolean; readonly error?: { readonly kind: string } }): string =>
  result.ok ? 'ok' : (result.error?.kind ?? 'unknown');
