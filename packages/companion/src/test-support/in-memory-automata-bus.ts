/**
 * Lite test support: an in-memory stand-in for the Postgres Automata Bus
 * store and the production runtime surfaces the worker port calls, with the
 * store's own eventId semantics (same id and same content is a replay, same
 * id and different content is refused). Used by the operator automata rule
 * tests (worker-write-keys.test.ts, host-execution.test.ts).
 */
import { vi } from 'vitest';

import type { AutomataBusEvent } from '../faculties/automata/bus/contract.js';
import type { AutomataBusProductionRuntime } from '../faculties/automata/bus/production-runtime.js';
import type { PostgresAutomataBusRuntimeStore } from '../faculties/automata/bus/runtime-store.js';

export interface InMemoryAutomataBus {
  readonly events: Map<string, { event: AutomataBusEvent; audiences: string[]; sensitivity: string }>;
  readonly store: PostgresAutomataBusRuntimeStore;
  readonly runtime: AutomataBusProductionRuntime;
}

export function createInMemoryAutomataBus(): InMemoryAutomataBus {
  const events: InMemoryAutomataBus['events'] = new Map();
  const store = {
    appendAllocated: vi.fn(async (input: {
      eventId: string;
      createEvent(sequence: number): unknown;
      audiences: string[];
      sensitivity: string;
    }) => {
      const incumbent = events.get(input.eventId);
      const event = input.createEvent(incumbent?.event.sequence ?? events.size + 1) as AutomataBusEvent;
      if (incumbent) {
        if (JSON.stringify(incumbent.event) !== JSON.stringify(event)) {
          throw new Error(`Automata Bus eventId ${input.eventId} was reused with different content`);
        }
        return { event: incumbent.event, inserted: false };
      }
      events.set(event.eventId, { event, audiences: [...input.audiences].sort(), sensitivity: input.sensitivity });
      return { event, inserted: true };
    }),
    readEventById: vi.fn(async (input: { eventId: string }) => events.get(input.eventId)?.event ?? null),
    readCurrentFindingsByEventIds: vi.fn(async (input: { eventIds: string[] }) => input.eventIds
      .map(id => events.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.event.type === 'finding')
      .map(entry => ({
        effectiveFinding: entry.event,
        audiences: entry.audiences,
        sensitivity: entry.sensitivity,
      }))),
  } as unknown as PostgresAutomataBusRuntimeStore;
  const runtime = {
    canonical: { getCurrentByEventIds: vi.fn(async () => []) },
    indexing: { indexCurrentFinding: vi.fn() },
    query: {
      createSpawnBriefing: vi.fn(async () => ({
        text: '',
        itemCount: 0,
        diagnostics: {
          cache: 'miss',
          semanticPath: 'exact-fallback',
          indexState: 'ready',
          reindexState: 'current',
          modelIdentity: null,
          indexingLag: { pendingCount: 0 },
        },
      })),
      search: vi.fn(async () => ({ results: [] })),
    },
  } as unknown as AutomataBusProductionRuntime;
  return { events, store, runtime };
}
