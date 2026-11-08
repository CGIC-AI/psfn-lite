/**
 * The conformance host: the real standalone runtime (every core stack, the
 * Postgres and JSONL adapters, the Pi harness) with the MCP transport and
 * the lifecycle bridge mounted, over state a runner owns (a database, a
 * spare database for restore, and a base directory for storage roots). The
 * scripted model is the only fake. It runs in its own process
 * (fixtures/host-process.ts) so a runner can kill it to crash the runtime and
 * start a successor over the same durable state.
 *
 * One conversation, two harnesses: the Hermes operator principal is bound to
 * the same direct room (`cli-direct`) as the standalone operator, so a Pi
 * turn and a Hermes turn are turns of one session. The friend principal is
 * bound to its own direct room on another channel.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHistoryBackupComponent, openFileBackupStore } from '../../../packages/adapters/src/index.ts';
import {
  createLiteRuntime,
  parseLiteConfig,
  randomIds,
  type LiteDiagnostic,
  type LiteRuntime,
  type LiteTickReport,
} from '../../../apps/standalone/src/index.ts';
import { openLiteStorage } from '../../../apps/standalone/src/storage.ts';
import { createContinuityBackup, type ContactId, type Result, type SessionId, type TrustedTurnScope } from '../../../packages/core/src/index.ts';
import { createDisabledEmbeddings } from '../../../packages/pi/src/index.ts';
import { FixedClock } from '../../core/fakes.ts';
import { liteConfigDocument } from '../../standalone/lite-config.ts';
import { captureInto, participantBlocks, type CallResult, type PlannedCall, type TurnObservation, type Vars } from '../scenario.ts';
import { ScriptedModel, toolResults, type BrainEvent, type ExtractionItem } from './brain.ts';

export const OPERATOR_ROOM = 'cli-direct';

/** Hermes principals of the conformance config: the operator in the standalone operator's own conversation, and a friend. */
export const CONFORMANCE_BINDINGS = {
  'hermes-operator': {
    surface: 'hermes',
    principal: { kind: 'channel_account', identity: { channelKind: 'cli', externalId: 'operator-1' } },
    room: { kind: 'direct', channelId: OPERATOR_ROOM },
    turnKind: 'foreground',
  },
  'hermes-friend': {
    surface: 'hermes',
    principal: { kind: 'channel_account', identity: { channelKind: 'telegram', externalId: 'friend-1' } },
    room: { kind: 'direct', channelId: 'friend-direct' },
    turnKind: 'foreground',
  },
} as const;
export type Principal = keyof typeof CONFORMANCE_BINDINGS;

/** Everything a successor process needs to continue over the same durable state. */
export interface HostState {
  readonly databaseUrl: string;
  /** An empty database a backup is restored into. */
  readonly spareDatabaseUrl: string;
  /** Storage roots live under here; a restore creates fresh ones beside them. */
  readonly base: string;
  readonly roots: { readonly history: string; readonly workspace: string; readonly backups: string } | null;
  readonly clockMs: number;
  readonly credentials: Readonly<Record<Principal, string>> | null;
  /** Null on first start (any free port); a successor binds the same ports so a host's configuration stays valid. */
  readonly ports: { readonly mcp: number; readonly lifecycle: number } | null;
  readonly internalTurns: 'harness' | 'delegated';
  readonly generation: number;
}

export interface Ready {
  readonly mcpUrl: string;
  readonly lifecycleUrl: string;
  readonly credentials: Readonly<Record<Principal, string>>;
  readonly vars: Vars;
  readonly state: HostState;
}

const envName = (principal: string) => `LITE_CONFORMANCE_${principal.toUpperCase().replace(/-/g, '_')}`;
const MIDDAY_MS = Date.parse('2030-01-01T12:00:00.000Z');

export class ConformanceHost {
  private runtime: LiteRuntime | null = null;
  private readonly clock: FixedClock;
  readonly model: ScriptedModel;
  readonly diagnostics: LiteDiagnostic[] = [];
  private state: HostState;
  private turns = 0;

  constructor(state: HostState, onEvent: (event: BrainEvent) => void) {
    this.state = state;
    this.clock = new FixedClock(new Date(state.clockMs === 0 ? MIDDAY_MS : state.clockMs));
    this.model = new ScriptedModel(onEvent);
  }

  snapshot(): HostState {
    return { ...this.state, clockMs: this.clock.now().getTime() };
  }

  private live(): LiteRuntime {
    if (this.runtime === null) throw new Error('the conformance runtime is not open');
    return this.runtime;
  }

  async open(): Promise<Ready> {
    const roots = this.state.roots ?? (await freshRoots(this.state.base, 'primary'));
    const credentials = this.state.credentials ?? (Object.fromEntries(Object.keys(CONFORMANCE_BINDINGS).map((p) => [p, randomBytes(32).toString('base64url')])) as Record<Principal, string>);
    const document = {
      ...liteConfigDocument(roots),
      harness: { turnLeaseMs: 60_000, maxModelCalls: 16, maxToolResultChars: 200_000, historyEntries: 50, selfStateItems: 10 },
      mcp: {
        host: '127.0.0.1',
        port: this.state.ports?.mcp ?? 0,
        allowedHosts: null,
        bindings: Object.entries(CONFORMANCE_BINDINGS).map(([principal, attestation]) => ({ principal, credential: { env: envName(principal) }, attestation })),
        internalTurnTtlMs: 120_000,
        maxOpenInternalTurns: 4,
      },
      lifecycle: {
        host: '127.0.0.1',
        port: this.state.ports?.lifecycle ?? 0,
        allowedHosts: null,
        internalTurns: this.state.internalTurns === 'delegated' ? { kind: 'delegated', host: 'hermes-operator', claimTimeoutMs: 20_000, runTimeoutMs: 60_000 } : { kind: 'harness' },
      },
    };
    const config = unwrap(parseLiteConfig(document));
    const runtime = unwrap(
      await createLiteRuntime({
        config,
        databaseUrl: this.state.databaseUrl,
        env: Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c])),
        host: {
          clock: this.clock,
          ids: randomIds,
          model: this.model.runtime,
          embeddings: createDisabledEmbeddings(),
          channel: { reply: () => Promise.resolve({ ok: true, value: undefined }), reminder: () => Promise.resolve({ ok: true, value: undefined }) },
          instance: `conformance-${String(this.state.generation)}-${randomBytes(3).toString('hex')}`,
          onDiagnostic: (d) => this.diagnostics.push(d),
        },
      }),
    );
    this.runtime = runtime;
    const { mcpUrl, lifecycleUrl } = runtime.transports;
    if (mcpUrl === null || lifecycleUrl === null) throw new Error('transports were not mounted');
    const operator = unwrap(await runtime.ensureOperator());
    const friend = await this.ensureFriend(runtime);
    this.state = { ...this.state, roots, credentials, ports: { mcp: portOf(mcpUrl), lifecycle: portOf(lifecycleUrl) } };
    return { mcpUrl, lifecycleUrl, credentials, vars: { 'contact.operator': operator.contactId, 'contact.friend': friend }, state: this.snapshot() };
  }

  private async ensureFriend(runtime: LiteRuntime): Promise<ContactId> {
    const identity = { channelKind: 'telegram', externalId: 'friend-1' };
    const known = unwrap(await runtime.stacks.contactAuthority.resolve(identity));
    if (known.kind === 'known') return known.contactId;
    const registered = unwrap(
      await runtime.stacks.contactAdmin.register('conformance:seed', {
        displayName: 'Sam',
        identity,
        trust: 'regular',
        relationship: 'friend',
        consent: 'granted',
        sensitivity: 'personal',
      }),
    );
    return registered.contactId;
  }

  async close(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.close();
  }

  // -- operations ------------------------------------------------------------

  /** One operator turn on the Pi harness, the companion following the plan. */
  async piTurn(input: { readonly say: string; readonly calls: readonly PlannedCall[]; readonly reply: string; readonly hang: boolean; readonly vars: Vars; readonly key: string }): Promise<TurnObservation & { readonly status: string | null }> {
    const runtime = this.live();
    const before = this.model.calls.length;
    this.model.companion = { calls: input.calls, reply: input.reply, hang: input.hang, vars: input.vars };
    this.turns += 1;
    try {
      const report = await runtime.converse({ text: input.say, idempotencyKey: input.key });
      const companion = this.model.calls.slice(before).filter((c) => c.kind === 'companion' && !c.lastUser.includes('Free time is open'));
      const first = companion[0];
      const last = companion.at(-1);
      const seen = first === undefined ? '' : [first.systemPrompt, ...first.context.messages.map((m) => renderMessage(m))].join('\n\n');
      const speech = first === undefined ? [] : first.context.messages.filter((m) => m.role === 'user').flatMap((m) => participantBlocks(renderMessage(m)));
      const results: CallResult[] = last === undefined ? [] : toolResults(last.context);
      const vars: Vars = { ...input.vars };
      results.forEach((result, i) => {
        if (result.ok) captureInto(vars, JSON.stringify(result.content), input.calls[i]?.capture);
      });
      if (!report.ok) return { turnId: null, refused: { kind: report.error.kind, ...reasonOf(report.error) }, seen, speech, results, vars, status: null };
      return { turnId: report.value.record.turnId, refused: null, seen, speech, results, vars, status: report.value.status };
    } finally {
      this.model.companion = null;
    }
  }

  advance(minutes: number): { readonly clockMs: number } {
    this.clock.advance(minutes * 60_000);
    return { clockMs: this.clock.now().getTime() };
  }

  async tick(plan: { readonly choice?: string; readonly reflection?: string }): Promise<Record<string, unknown>> {
    this.model.freeTime = { choice: plan.choice ?? 'rest', reflection: plan.reflection ?? 'A quiet thought.' };
    const before = this.model.calls.length;
    const report = unwrap(await this.live().tick());
    return { modelCalls: this.model.calls.length - before, ...summarizeTick(report) };
  }

  async maintain(extract: readonly ExtractionItem[]): Promise<Record<string, unknown>> {
    this.model.extraction = extract;
    const before = this.model.calls.length;
    const report = await this.live().maintain();
    this.model.extraction = [];
    return { modelCalls: this.model.calls.length - before, ok: report.ok, report: report.ok ? report.value : report.error };
  }

  async consent(input: { readonly contact: string; readonly consent: 'granted' | 'pending' | 'denied' | 'revoked' }): Promise<unknown> {
    return unwrap(await this.live().stacks.contactAdmin.setConsent('conformance:operator', input.contact as ContactId, input.consent));
  }

  workerPlan(plan: { readonly calls?: readonly PlannedCall[]; readonly reply?: string; readonly hang?: boolean }): { readonly set: true } {
    this.model.worker = { calls: plan.calls ?? [], reply: plan.reply ?? 'Worker finished.', hang: plan.hang ?? false };
    return { set: true };
  }

  /** A governed call as the operator (in their direct conversation) or as the companion's own internal turn: inspection through the same dispatcher. */
  async dispatch(input: { readonly as: 'operator' | 'self'; readonly tool: string; readonly action: string; readonly args?: Record<string, unknown> }): Promise<CallResult> {
    const runtime = this.live();
    const scope: TrustedTurnScope = unwrap(input.as === 'operator' ? await runtime.ingress.admit(runtime.host.operatorEvidence()) : await runtime.internalScope('reflection'));
    const result = await runtime.dispatcher.dispatch(scope, { tool: input.tool, action: input.action, args: input.args ?? {} });
    return result.ok ? { ok: true, content: result.value.content } : { ok: false, error: { kind: result.error.kind, ...reasonOf(result.error) } };
  }

  /** The operator conversation's canonical history, read from the JSONL archive. */
  async history(): Promise<readonly { readonly origin: string; readonly text: string; readonly turnId: string }[]> {
    const runtime = this.live();
    const scope = unwrap(await runtime.ingress.admit(runtime.host.operatorEvidence()));
    const session = unwrap(await runtime.stacks.sessions.current(scope));
    const tail = unwrap(await runtime.storage.archive.readTail(session.sessionId as SessionId, 1_000));
    return tail.map((e) => ({ origin: e.origin.kind, text: e.text, turnId: e.turnId }));
  }

  /**
   * A complete continuity backup (JSONL history and every Postgres table),
   * restored into fresh storage roots and the spare database, then the
   * runtime reopened on the restored state. The original roots and database
   * are left untouched and no longer used.
   */
  async backupRestore(): Promise<Record<string, unknown>> {
    const runtime = this.live();
    const set = `conformance-${String(this.state.generation)}`;
    const store = unwrap(await openFileBackupStore(runtime.storage.layout, set));
    const backup = unwrap(createContinuityBackup({ components: [createHistoryBackupComponent(runtime.storage.archive), runtime.storage.state.backup], clock: this.clock }));
    const manifest = unwrap(await backup.backup(store));
    const sourceLayout = runtime.storage.layout;
    await this.close();

    const roots = await freshRoots(this.state.base, `restored-${String(this.state.generation)}`);
    const target = unwrap(
      await openLiteStorage({
        storage: { historyRoot: roots.history, workspaceRoot: roots.workspace, backupRoot: roots.backups },
        databaseUrl: this.state.spareDatabaseUrl,
        space: { name: 'test-space', dimensions: 3 },
        onIdleError: (error) => this.diagnostics.push({ kind: 'pool_idle_error', message: error.message }),
      }),
    );
    try {
      const restore = unwrap(createContinuityBackup({ components: [createHistoryBackupComponent(target.archive), target.state.backup], clock: this.clock }));
      unwrap(await restore.restore(unwrap(await openFileBackupStore(sourceLayout, set))));
    } finally {
      await target.close();
    }
    this.state = { ...this.state, roots, databaseUrl: this.state.spareDatabaseUrl, generation: this.state.generation + 1 };
    await this.open();
    return { restored: true, components: manifest.components.map((c) => c.name) };
  }

  async restart(): Promise<Ready> {
    await this.close();
    this.state = { ...this.state, generation: this.state.generation + 1 };
    return this.open();
  }

  /** The tool surface the companion's model was given on its last Pi turn: names and action enums. */
  piTools(): readonly { readonly name: string; readonly actions: readonly string[] }[] {
    const last = [...this.model.calls].reverse().find((c) => c.kind === 'companion');
    if (last === undefined) throw new Error('no companion model call yet');
    return (last.context.tools ?? []).map((tool) => ({ name: tool.name, actions: actionEnum(tool.parameters) }));
  }

  modelCalls(): Record<string, number> {
    return this.model.counts();
  }
}

function summarizeTick(report: LiteTickReport): Record<string, unknown> {
  const s = report.scheduler;
  if (!s.ok) return { ok: false, error: s.error };
  return {
    ok: true,
    freeTime: s.value.freeTime.map((r) => (r.ok ? (r.value.kind === 'ran' ? `ran:${r.value.block.state}` : `skipped:${r.value.reason}`) : `error:${r.error.kind}`)),
    workers: s.value.workers.ok ? s.value.workers.value : { error: s.value.workers.error },
    resumedWorkers: s.value.resumedWorkers.ok ? s.value.resumedWorkers.value : { error: s.value.resumedWorkers.error },
  };
}

async function freshRoots(base: string, name: string) {
  const roots = { history: join(base, name, 'history'), workspace: join(base, name, 'workspace'), backups: join(base, name, 'backups') };
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true });
  return roots;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function renderMessage(message: { readonly role: string; readonly content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
}

function actionEnum(parameters: unknown): string[] {
  const action = (parameters as { properties?: { action?: { const?: string; anyOf?: { const?: string }[] } } }).properties?.action;
  if (action?.const !== undefined) return [action.const];
  return (action?.anyOf ?? []).map((a) => a.const ?? '');
}

function reasonOf(error: object): { readonly reason?: string } {
  const fields = error as Record<string, unknown>;
  const reason = fields['reason'] ?? fields['capability'];
  return typeof reason === 'string' ? { reason } : {};
}

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
