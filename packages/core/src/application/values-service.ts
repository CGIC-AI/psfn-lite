import {
  activeNorthStar,
  createNorthStarItem,
  reorderNorthStar,
  retireNorthStarItem,
  reviseNorthStarItem,
  type NorthStarItem,
  type NorthStarPort,
  type NorthStarState,
  type ValueEntry,
  type ValuesJournalPort,
} from '../identity/index.ts';
import { denied, invalid, isNonEmptyString, ok, type Clock, type IdSource, type Result } from '../shared/index.ts';
import { authorOf, isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

const VALUE_MAX_CHARS = 4_000;

export interface ValuesService {
  listValues(scope: TrustedTurnScope, input: { readonly limit: number }): Promise<Result<readonly ValueEntry[]>>;
  addValue(scope: TrustedTurnScope, input: { readonly value: string; readonly context: string | null }): Promise<Result<ValueEntry>>;
  reviseValue(
    scope: TrustedTurnScope,
    input: { readonly version: number; readonly value: string; readonly context: string | null },
  ): Promise<Result<ValueEntry>>;
  northStarList(scope: TrustedTurnScope): Promise<Result<readonly NorthStarItem[]>>;
  northStarCreate(scope: TrustedTurnScope, input: { readonly title: string; readonly content: string }): Promise<Result<readonly NorthStarItem[]>>;
  northStarUpdate(
    scope: TrustedTurnScope,
    input: { readonly itemId: string; readonly title?: string; readonly content?: string; readonly enabled?: boolean },
  ): Promise<Result<readonly NorthStarItem[]>>;
  northStarReorder(scope: TrustedTurnScope, input: { readonly order: readonly string[] }): Promise<Result<readonly NorthStarItem[]>>;
  northStarRetire(scope: TrustedTurnScope, input: { readonly itemId: string }): Promise<Result<readonly NorthStarItem[]>>;
}

/**
 * The companion-authored values journal (append-only; a revision is a new
 * version that names the one it derives from) and the North Star, which
 * holds at most three active items and retires rather than deletes.
 */
export function createValuesService(deps: {
  readonly values: ValuesJournalPort;
  readonly northStar: NorthStarPort;
  readonly clock: Clock;
  readonly ids: IdSource;
}): ValuesService {
  const appendValue = async (
    scope: TrustedTurnScope,
    input: { readonly value: string; readonly context: string | null; readonly derivedFromVersion: number | null },
  ): Promise<Result<ValueEntry>> => {
    const reflection = input.value.trim();
    if (reflection.length === 0 || reflection.length > VALUE_MAX_CHARS) return invalid(`value must be 1-${VALUE_MAX_CHARS} characters`);
    const latest = await deps.values.latestVersion();
    if (!latest.ok) return latest;
    return deps.values.append({
      id: deps.ids.next('value'),
      version: latest.value + 1,
      reflection,
      context: input.context?.trim() ?? null,
      author: authorOf(scope),
      derivedFromVersion: input.derivedFromVersion,
      createdAt: deps.clock.now().toISOString(),
    });
  };

  const changeNorthStar = async (
    scope: TrustedTurnScope,
    reason: string,
    change: (state: NorthStarState, meta: { readonly author: ReturnType<typeof authorOf>; readonly at: string }) => Result<readonly NorthStarItem[]>,
  ): Promise<Result<readonly NorthStarItem[]>> => {
    if (!isTrustedTurnScope(scope)) return untrusted();
    const state = await deps.northStar.read();
    if (!state.ok) return state;
    const next = change(state.value, { author: authorOf(scope), at: deps.clock.now().toISOString() });
    if (!next.ok) return next;
    const saved = await deps.northStar.save(next.value, state.value.revision, reason);
    return saved.ok ? ok(activeNorthStar(saved.value.items)) : saved;
  };

  return {
    async listValues(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return deps.values.list(input.limit);
    },

    async addValue(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return appendValue(scope, { ...input, derivedFromVersion: null });
    },

    async reviseValue(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const source = await deps.values.get(input.version);
      if (!source.ok) return source;
      return appendValue(scope, { value: input.value, context: input.context, derivedFromVersion: source.value.version });
    },

    async northStarList(scope) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const state = await deps.northStar.read();
      return state.ok ? ok(activeNorthStar(state.value.items)) : state;
    },

    northStarCreate: (scope, input) =>
      changeNorthStar(scope, 'create', (state, meta) => {
        if (!isNonEmptyString(input.title) || !isNonEmptyString(input.content)) return invalid('North Star title and content must be non-empty');
        return createNorthStarItem(state.items, { id: deps.ids.next('north_star'), title: input.title, content: input.content, ...meta });
      }),

    northStarUpdate: (scope, input) =>
      changeNorthStar(scope, 'update', (state, meta) => {
        const { itemId, ...patch } = input;
        return reviseNorthStarItem(state.items, itemId, patch, meta);
      }),

    northStarReorder: (scope, input) => changeNorthStar(scope, 'reorder', (state, meta) => reorderNorthStar(state.items, input.order, meta)),

    northStarRetire: (scope, input) => changeNorthStar(scope, 'retire', (state, meta) => retireNorthStarItem(state.items, input.itemId, meta)),
  };
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
