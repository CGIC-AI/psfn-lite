import {
  CORE_BLOCK_NAMES,
  LAYER_TYPES,
  appendToBlock,
  applyPersonaPatch,
  checksumOf,
  lineDiff,
  protectedFieldsIn,
  replaceInBlock,
  withinLimit,
  type CoreBlock,
  type CoreBlockName,
  type CoreBlockPort,
  type CoreBlockScope,
  type LayerChangeProposal,
  type LayerType,
  type PersonaPatch,
  type PersonaPort,
  type PersonaVersion,
  type PromptLayer,
  type PromptLayerPort,
  type PromptLayerVersion,
} from '../identity/index.ts';
import {
  denied,
  fail,
  invalid,
  isNonEmptyString,
  isOneOf,
  ok,
  type Author,
  type Clock,
  type Result,
} from '../shared/index.ts';
import type { ApprovalPort } from './host-ports.ts';
import { authorOf, isTrustedTurnScope, type TrustedTurnScope } from './trusted-scope.ts';

export type IdentityWriteOutcome<T> =
  | { readonly status: 'applied'; readonly value: T }
  | { readonly status: 'unchanged'; readonly value: T }
  | { readonly status: 'proposed'; readonly proposalId: string };

export interface OrientationService {
  view(scope: TrustedTurnScope): Promise<Result<readonly CoreBlock[]>>;
  append(scope: TrustedTurnScope, input: { readonly block: CoreBlockName; readonly text: string }): Promise<Result<readonly CoreBlock[]>>;
  replace(
    scope: TrustedTurnScope,
    input: { readonly block: CoreBlockName; readonly oldText: string; readonly newText: string },
  ): Promise<Result<readonly CoreBlock[]>>;
  reorient(scope: TrustedTurnScope, input: Readonly<Record<CoreBlockName, string>>): Promise<Result<readonly CoreBlock[]>>;
  listLayers(scope: TrustedTurnScope): Promise<Result<readonly PromptLayer[]>>;
  getLayer(scope: TrustedTurnScope, layerId: string): Promise<Result<PromptLayer>>;
  diffLayer(
    scope: TrustedTurnScope,
    input: { readonly layerId: string; readonly version: number | null },
  ): Promise<Result<{ readonly fromVersion: number | null; readonly toVersion: number; readonly added: readonly string[]; readonly removed: readonly string[] }>>;
  layerHistory(scope: TrustedTurnScope, input: { readonly layerId: string; readonly limit: number }): Promise<Result<readonly PromptLayerVersion[]>>;
  updateLayer(
    scope: TrustedTurnScope,
    input: { readonly layerId: string; readonly content: string; readonly reason: string },
  ): Promise<Result<IdentityWriteOutcome<PromptLayer>>>;
  rollbackLayer(
    scope: TrustedTurnScope,
    input: { readonly layerId: string; readonly version: number; readonly reason: string },
  ): Promise<Result<IdentityWriteOutcome<PromptLayer>>>;
  toggleLayer(scope: TrustedTurnScope, input: { readonly layerId: string; readonly reason: string }): Promise<Result<IdentityWriteOutcome<PromptLayer>>>;
  updatePersona(
    scope: TrustedTurnScope,
    input: { readonly patch: PersonaPatch; readonly reason: string },
  ): Promise<Result<IdentityWriteOutcome<PersonaVersion>>>;
}

export interface OrientationDeps {
  readonly blocks: CoreBlockPort;
  readonly layers: PromptLayerPort;
  readonly persona: PersonaPort;
  readonly approvals: ApprovalPort;
  readonly clock: Clock;
}

/**
 * Orientation blocks, prompt layers and the persona card. Blocks belong to the
 * current conversation only. Base and operator layers and the protected
 * persona fields are never changed by the companion directly: those changes
 * become approval proposals carrying the version and checksum they were based
 * on, so a stale approval can be refused.
 */
export function createOrientationService(deps: OrientationDeps): OrientationService {
  const commitLayer = async (
    scope: TrustedTurnScope,
    layer: PromptLayer,
    next: { readonly content: string; readonly enabled: boolean; readonly reason: string },
    change: LayerChangeProposal['change'],
  ): Promise<Result<IdentityWriteOutcome<PromptLayer>>> => {
    if (next.content === layer.content && next.enabled === layer.enabled) return ok({ status: 'unchanged', value: layer });
    if (isProtectedLayer(layer.type)) {
      const proposal: LayerChangeProposal = {
        layerId: layer.id,
        change,
        previousVersion: layer.version,
        previousChecksum: layer.checksum,
        ...(next.content === layer.content ? {} : { proposedContent: next.content }),
        ...(next.enabled === layer.enabled ? {} : { proposedEnabled: next.enabled }),
        reason: next.reason,
      };
      const submitted = await deps.approvals.submit({
        kind: `identity.prompt_layer.${change}`,
        summary: `${change} ${layer.type} layer ${layer.name} (v${layer.version})`,
        payload: { ...proposal },
        requestedBy: authorOf(scope),
      });
      return submitted.ok ? ok({ status: 'proposed', proposalId: submitted.value.proposalId }) : submitted;
    }
    const committed = await deps.layers.commit(layerVersion(layer.id, layer.version + 1, next, authorOf(scope), deps.clock), layer.version);
    return committed.ok ? ok({ status: 'applied', value: committed.value }) : committed;
  };

  const editBlocks = async (
    scope: TrustedTurnScope,
    edit: (blocks: ReadonlyMap<CoreBlockName, CoreBlock>) => Result<readonly { readonly block: CoreBlock; readonly text: string }[]>,
  ): Promise<Result<readonly CoreBlock[]>> => {
    const blockScope = conversationScope(scope);
    if (!blockScope.ok) return blockScope;
    const current = await deps.blocks.read(blockScope.value);
    if (!current.ok) return current;
    const edits = edit(new Map(current.value.map((b) => [b.name, b])));
    if (!edits.ok) return edits;
    return deps.blocks.write({
      scope: blockScope.value,
      changes: edits.value.map(({ block, text }) => ({ name: block.name, text, expectedRevision: block.revision })),
      author: authorOf(scope),
      at: deps.clock.now().toISOString(),
    });
  };

  return {
    async view(scope) {
      const blockScope = conversationScope(scope);
      if (!blockScope.ok) return blockScope;
      return deps.blocks.read(blockScope.value);
    },

    append: (scope, input) =>
      editBlocks(scope, (blocks) => {
        const block = blocks.get(input.block);
        if (block === undefined) return invalid(`unknown block ${input.block}`);
        const text = appendToBlock(block, input.text);
        return text.ok ? ok([{ block, text: text.value }]) : text;
      }),

    replace: (scope, input) =>
      editBlocks(scope, (blocks) => {
        const block = blocks.get(input.block);
        if (block === undefined) return invalid(`unknown block ${input.block}`);
        const text = replaceInBlock(block, input.oldText, input.newText);
        return text.ok ? ok([{ block, text: text.value }]) : text;
      }),

    reorient: (scope, input) =>
      editBlocks(scope, (blocks) => {
        const edits: { block: CoreBlock; text: string }[] = [];
        const issues: string[] = [];
        for (const name of CORE_BLOCK_NAMES) {
          const block = blocks.get(name);
          if (block === undefined) return invalid(`unknown block ${name}`);
          const text = withinLimit(block, input[name].trim());
          if (text.ok) edits.push({ block, text: text.value });
          else if (text.error.kind === 'invalid') issues.push(...text.error.issues);
        }
        return issues.length > 0 ? invalid(...issues) : ok(edits);
      }),

    async listLayers(scope) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const layers = await deps.layers.list();
      if (!layers.ok) return layers;
      return ok([...layers.value].sort((a, b) => LAYER_TYPES.indexOf(a.type) - LAYER_TYPES.indexOf(b.type) || a.id.localeCompare(b.id)));
    },

    async getLayer(scope, layerId) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return deps.layers.get(layerId);
    },

    async diffLayer(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const layer = await deps.layers.get(input.layerId);
      if (!layer.ok) return layer;
      const toVersion = input.version ?? layer.value.version;
      if (toVersion < 1 || toVersion > layer.value.version) return invalid(`layer ${input.layerId} has versions 1-${layer.value.version}`);
      const to = await deps.layers.version(input.layerId, toVersion);
      if (!to.ok) return to;
      if (toVersion === 1) return ok({ fromVersion: null, toVersion, ...lineDiff('', to.value.content) });
      const from = await deps.layers.version(input.layerId, toVersion - 1);
      if (!from.ok) return from;
      return ok({ fromVersion: toVersion - 1, toVersion, ...lineDiff(from.value.content, to.value.content) });
    },

    async layerHistory(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      return deps.layers.history(input.layerId, input.limit);
    },

    async updateLayer(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (!isNonEmptyString(input.content)) return invalid('layer content must be non-empty');
      const layer = await deps.layers.get(input.layerId);
      if (!layer.ok) return layer;
      return commitLayer(scope, layer.value, { content: input.content, enabled: layer.value.enabled, reason: input.reason }, 'update');
    },

    async rollbackLayer(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const layer = await deps.layers.get(input.layerId);
      if (!layer.ok) return layer;
      if (input.version >= layer.value.version) return invalid(`rollback target must be an earlier version than v${layer.value.version}`);
      const target = await deps.layers.version(input.layerId, input.version);
      if (!target.ok) return target;
      return commitLayer(scope, layer.value, { content: target.value.content, enabled: layer.value.enabled, reason: input.reason }, 'rollback');
    },

    async toggleLayer(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      const layer = await deps.layers.get(input.layerId);
      if (!layer.ok) return layer;
      return commitLayer(scope, layer.value, { content: layer.value.content, enabled: !layer.value.enabled, reason: input.reason }, 'toggle');
    },

    async updatePersona(scope, input) {
      if (!isTrustedTurnScope(scope)) return untrusted();
      if (Object.keys(input.patch).length === 0) return invalid('update_persona needs at least one field');
      const current = await deps.persona.current();
      if (!current.ok) return current;
      const card = current.value?.card ?? null;
      const protectedFields = protectedFieldsIn(card, input.patch);
      const version = current.value?.version ?? 0;
      if (protectedFields.length > 0) {
        const submitted = await deps.approvals.submit({
          kind: 'identity.persona.update',
          summary: `persona change to protected fields: ${protectedFields.join(', ')}`,
          payload: { patch: input.patch, previousVersion: version, previousChecksum: current.value?.checksum ?? null, reason: input.reason },
          requestedBy: authorOf(scope),
        });
        return submitted.ok ? ok({ status: 'proposed', proposalId: submitted.value.proposalId }) : submitted;
      }
      const next = applyPersonaPatch(card, input.patch);
      const checksum = checksumOf(next);
      if (current.value !== null && checksum === current.value.checksum) return ok({ status: 'unchanged', value: current.value });
      const committed = await deps.persona.commit(
        { version: version + 1, card: next, checksum, author: authorOf(scope), reason: input.reason, at: deps.clock.now().toISOString() },
        version,
      );
      return committed.ok ? ok({ status: 'applied', value: committed.value }) : committed;
    },
  };
}

/**
 * Operator-only identity administration: defining layers, applying approved
 * layer proposals with stale checks, and writing the persona card.
 */
export interface IdentityAdministration {
  defineLayer(
    operator: string,
    input: { readonly id: string; readonly name: string; readonly type: LayerType; readonly content: string },
  ): Promise<Result<PromptLayer>>;
  applyLayerProposal(operator: string, proposal: LayerChangeProposal): Promise<Result<PromptLayer>>;
  setPersona(operator: string, patch: PersonaPatch, reason: string): Promise<Result<PersonaVersion>>;
}

export function createIdentityAdministration(deps: {
  readonly layers: PromptLayerPort;
  readonly persona: PersonaPort;
  readonly clock: Clock;
}): IdentityAdministration {
  const operatorAuthor = (operator: string): Result<Author> =>
    isNonEmptyString(operator) ? ok({ kind: 'operator', actor: operator.trim() }) : invalid('operator actor must be named');
  return {
    async defineLayer(operator, input) {
      const author = operatorAuthor(operator);
      if (!author.ok) return author;
      if (!isNonEmptyString(input.id) || !isNonEmptyString(input.name)) return invalid('layer id and name must be non-empty');
      if (!isOneOf(LAYER_TYPES, input.type)) return invalid('layer type is unknown');
      return deps.layers.commit(
        layerVersion(input.id, 1, { content: input.content, enabled: true, reason: 'defined by operator' }, author.value, deps.clock),
        0,
        { name: input.name, type: input.type },
      );
    },

    async applyLayerProposal(operator, proposal) {
      const author = operatorAuthor(operator);
      if (!author.ok) return author;
      const layer = await deps.layers.get(proposal.layerId);
      if (!layer.ok) return layer;
      if (layer.value.version !== proposal.previousVersion || layer.value.checksum !== proposal.previousChecksum) {
        return fail({
          kind: 'conflict',
          reason: 'stale_revision',
          expectedRevision: proposal.previousVersion,
          actualRevision: layer.value.version,
          detail: 'the layer changed after the proposal was made; review the current version and propose again',
        });
      }
      const next = {
        content: proposal.proposedContent ?? layer.value.content,
        enabled: proposal.proposedEnabled ?? layer.value.enabled,
        reason: proposal.reason,
      };
      return deps.layers.commit(layerVersion(layer.value.id, layer.value.version + 1, next, author.value, deps.clock), layer.value.version);
    },

    async setPersona(operator, patch, reason) {
      const author = operatorAuthor(operator);
      if (!author.ok) return author;
      const current = await deps.persona.current();
      if (!current.ok) return current;
      const card = applyPersonaPatch(current.value?.card ?? null, patch);
      const version = current.value?.version ?? 0;
      return deps.persona.commit({ version: version + 1, card, checksum: checksumOf(card), author: author.value, reason, at: deps.clock.now().toISOString() }, version);
    },
  };
}

function isProtectedLayer(type: LayerType): boolean {
  return type === 'base' || type === 'operator';
}

function layerVersion(
  layerId: string,
  version: number,
  next: { readonly content: string; readonly enabled: boolean; readonly reason: string },
  author: Author,
  clock: Clock,
): PromptLayerVersion {
  return {
    layerId,
    version,
    content: next.content,
    enabled: next.enabled,
    checksum: checksumOf({ content: next.content, enabled: next.enabled }),
    author,
    reason: next.reason,
    at: clock.now().toISOString(),
  };
}

function conversationScope(scope: TrustedTurnScope): Result<CoreBlockScope> {
  if (!isTrustedTurnScope(scope)) return untrusted();
  if (scope.audience.kind === 'self') return invalid('orientation blocks belong to a conversation; self turns have none');
  return ok({ kind: 'conversation', channelId: scope.audience.channelId });
}

function untrusted() {
  return denied('unknown_authority', 'scope was not admitted by ingress');
}
