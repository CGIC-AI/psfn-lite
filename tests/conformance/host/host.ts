/**
 * The conformance host: the real standalone runtime (the extracted companion
 * core with the MCP transport and the lifecycle bridge mounted) over state a
 * runner owns (a database and a data directory). The scripted model is the
 * only model fake. It runs in its own process (fixtures/host-process.ts),
 * because the donor runs one companion runtime per process, and so a runner
 * can kill it to crash the runtime and start a successor over the same
 * durable state.
 *
 * One conversation, two surfaces: a Pi turn is a donor-driven turn (the
 * donor agent loop calls the scripted model through the Pi model port and
 * runs its tool calls) on the very session channel the Hermes operator's
 * host-driven turns use (the bridge's channel for the operator principal and
 * the conformance session id), so the two are turns of one donor session.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLiteRuntime, parseLiteConfig, runCli, type LiteRuntime } from '../../../apps/standalone/src/index.ts';
import { donorToolDefinitions, hostContextOf } from '../../../packages/lifecycle/src/index.ts';
import { createTurnId, externalMemorySessionId, type LLMContext } from '../../../packages/lifecycle/src/companion.ts';
import { renderContext } from '../../../packages/lifecycle/src/wire.ts';
import { deterministicEmbeddings } from '../../support/embeddings.ts';
import { fauxModel, type ModelCall, type Script } from '../../support/faux-model.ts';
import { DATABASE_URL_ENV, HERMES_TEST_INSTALL_ID, SESSION_KEYS_ENV, liteConfigDocument, newCredential, newSessionKeys, provisionDatabase, writeCharacterCard, type LiteConfigDocument } from '../../support/lite-install.ts';
import { captureInto, observe, resolveTemplates, type CallResult, type PlannedCall, type TurnObservation, type Vars } from '../scenario.ts';

/** Hermes principals of the conformance config and the contact each is bound to. */
export const PRINCIPALS = { 'hermes-operator': 'operator', 'hermes-friend': 'sam' } as const;
export type Principal = keyof typeof PRINCIPALS;
/** The Hermes session the operator's conversation is; Pi turns join its donor session channel. */
export const OPERATOR_SESSION = 'conformance-operator';
/** Short enough that a scenario can wait out an abandoned host-driven turn. */
export const HOST_TURN_TIMEOUT_MS = 4_000;
const LAPSE_MARGIN_MS = 30_000;

/** Everything a successor process needs to continue over the same durable state. */
export interface HostState {
  readonly databaseUrl: string;
  /** The standalone data directory; created and seeded (`init`) on first start. */
  readonly base: string;
  readonly companionId: string | null;
  readonly credentials: Readonly<Record<Principal, string>> | null;
  /** The session keyring (`<version>:<key>`); null on first start, kept by successors so the journals verify. */
  readonly sessionKeys: string | null;
  /** Null on first start (any free port); a successor binds the same ports so a host's configuration stays valid. */
  readonly ports: { readonly mcp: number; readonly lifecycle: number } | null;
  readonly generation: number;
}

export interface Ready {
  readonly mcpUrl: string;
  readonly lifecycleUrl: string;
  readonly credentials: Readonly<Record<Principal, string>>;
  /** The light Garden and its own operator credential, when the host was opened with `garden: true`. */
  readonly garden: { readonly url: string; readonly credential: string } | null;
  readonly vars: Vars;
  readonly state: HostState;
}

export interface PiTurnInput {
  readonly say: string;
  readonly calls: readonly PlannedCall[];
  readonly reply: string;
  readonly vars: Vars;
  readonly key: string;
}

interface PiPlan {
  readonly input: PiTurnInput;
  readonly vars: Vars;
  readonly results: CallResult[];
  first: LLMContext | null;
}

const envName = (principal: string) => `LITE_CONFORMANCE_${principal.toUpperCase().replace(/-/g, '_')}`;
const GARDEN_ENV = 'LITE_CONFORMANCE_GARDEN';

export class ConformanceHost {
  private runtime: LiteRuntime | null = null;
  private plan: PiPlan | null = null;
  private lastOffered: readonly string[] = [];
  private readonly model: ReturnType<typeof fauxModel>;
  private state: HostState;
  private readonly garden: boolean;

  /**
   * `options.modelApi`: the pi-ai API the faux model reports (tests/support/faux-model.ts FauxModelOptions).
   * `options.garden`: also mount the light Garden, with a fresh credential bound to the operator.
   */
  constructor(state: HostState, options: { readonly modelApi?: string; readonly garden?: boolean } = {}) {
    this.state = state;
    this.garden = options.garden === true;
    this.model = fauxModel((call) => this.answer(call), options.modelApi === undefined ? {} : { api: options.modelApi });
  }

  snapshot(): HostState {
    return this.state;
  }

  private live(): LiteRuntime {
    if (this.runtime === null) throw new Error('the conformance runtime is not open');
    return this.runtime;
  }

  async open(): Promise<Ready> {
    const first = this.state.companionId === null;
    const companionId = this.state.companionId ?? crypto.randomUUID();
    const credentials = this.state.credentials ?? (Object.fromEntries(Object.keys(PRINCIPALS).map((p) => [p, newCredential()])) as Record<Principal, string>);
    const document = liteConfigDocument(this.state.base, companionId);
    document.mcp = {
      host: '127.0.0.1',
      port: this.state.ports?.mcp ?? 0,
      allowedHosts: null,
      bindings: Object.entries(PRINCIPALS).map(([principal, contact]) => ({ principal, credential: { env: envName(principal) }, contact })),
    };
    document.lifecycle = { host: '127.0.0.1', port: this.state.ports?.lifecycle ?? 0, allowedHosts: null, hostTurnTimeoutMs: HOST_TURN_TIMEOUT_MS, hermesInstallId: HERMES_TEST_INSTALL_ID, automata: null };
    const gardenCredential = this.garden ? newCredential() : null;
    if (gardenCredential !== null) {
      document.garden = { host: '127.0.0.1', port: 0, allowedHosts: null, maxBodyBytes: 65_536, recentTurnLimit: 12,
        bindings: [{ principal: 'garden-operator', credential: { env: GARDEN_ENV }, contact: 'operator' }] };
    }
    const sessionKeys = this.state.sessionKeys ?? newSessionKeys();
    const env: Record<string, string> = {
      [DATABASE_URL_ENV]: this.state.databaseUrl,
      [SESSION_KEYS_ENV]: sessionKeys,
      ...Object.fromEntries(Object.entries(credentials).map(([p, c]) => [envName(p), c])),
      ...(gardenCredential === null ? {} : { [GARDEN_ENV]: gardenCredential }),
    };
    if (first) await this.install(document, env);
    const config = parseLiteConfig(document);
    if (!config.ok) throw new Error(JSON.stringify(config.error));
    const runtime = await createLiteRuntime({
      config: config.value,
      secrets: { databaseUrl: this.state.databaseUrl, modelApiKey: null, textEmotionApiKey: null },
      env,
      onDiagnostic: () => undefined,
      overrides: {
        model: this.model.runtime,
        embeddings: deterministicEmbeddings,
        textEmotionClassifier: { preload: () => Promise.resolve(), classify: () => Promise.resolve([{ label: 'neutral', score: 1 }]) },
      },
    });
    if (!runtime.ok) throw new Error(JSON.stringify(runtime.error));
    this.runtime = runtime.value;
    const { mcpUrl, lifecycleUrl, gardenUrl } = runtime.value.transports;
    if (mcpUrl === null || lifecycleUrl === null) throw new Error('transports were not mounted');
    const garden = gardenUrl === null || gardenCredential === null ? null : { url: gardenUrl, credential: gardenCredential };
    this.state = { ...this.state, companionId, credentials, sessionKeys, ports: { mcp: Number(new URL(mcpUrl).port), lifecycle: Number(new URL(lifecycleUrl).port) } };
    const contact = (key: string) => runtime.value.contactIds.get(key) ?? '';
    return { mcpUrl, lifecycleUrl, credentials, garden, vars: { 'contact.operator': contact('operator'), 'contact.friend': contact('sam') }, state: this.state };
  }

  /** The real `init` seeds the data directory; the database gets the donor's extension schema. */
  private async install(document: LiteConfigDocument, env: Record<string, string>): Promise<void> {
    await mkdir(this.state.base, { recursive: true });
    await provisionDatabase(this.state.databaseUrl);
    await writeCharacterCard(document.characterCardPath);
    const configPath = join(this.state.base, 'lite.json');
    await writeFile(configPath, JSON.stringify(document, null, 2));
    let stderr = '';
    const code = await runCli(['init', '--config', configPath], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      env,
      readFile: (path) => readFile(path, 'utf8'),
      lines: async function* () {},
      onInterrupt: () => () => undefined,
    });
    if (code !== 0) throw new Error(`init failed: ${stderr}`);
  }

  /** The donor session channel of the operator's conversation (as the bridge derives it for the operator principal). */
  private operatorChannel(): string {
    const runtime = this.live();
    return externalMemorySessionId(
      { bodyId: 'hermes-operator', companionId: runtime.config.companionId, contactId: runtime.contactIds.get('operator') ?? '' },
      OPERATOR_SESSION,
    );
  }

  /** A donor-driven turn of the operator's conversation: the scripted model makes the planned tool calls, then replies. */
  async piTurn(input: PiTurnInput): Promise<TurnObservation> {
    const runtime = this.live();
    if (this.plan !== null) throw new Error('a Pi turn is already running');
    const plan: PiPlan = { input, vars: { ...input.vars }, results: [], first: null };
    this.plan = plan;
    const turnId = createTurnId();
    try {
      await runtime.companion.agentLoop.handleMessage({
        id: `pi:${input.key}`,
        channelId: this.operatorChannel(),
        channelType: 'api',
        authorId: runtime.config.operator.userId,
        authorName: runtime.config.operator.displayName,
        content: input.say,
        timestamp: new Date(),
        isDirectMessage: true,
        routing: { turnId, canonicalContactId: runtime.contactIds.get('operator') ?? '' },
      });
    } finally {
      this.plan = null;
    }
    if (plan.first === null) throw new Error(`the companion model was never called for ${JSON.stringify(input.say)}`);
    const context = renderContext(hostContextOf(plan.first));
    this.lastOffered = (context['tools'] as string[] | undefined) ?? [];
    return { turnId, refused: null, ...observe(context), results: plan.results, vars: plan.vars };
  }

  /** The scripted model: the open Pi turn's planned calls, one per model call, then its reply; `{}` for everything else. */
  private answer(call: ModelCall): ReturnType<Script> {
    const plan = this.plan;
    if (plan === null || !call.lastUser.includes(plan.input.say) || (call.context.tools?.length ?? 0) === 0) return null;
    // The donor stream transport context is the pi-ai context it sent (hostContextOf reads the same shape).
    plan.first ??= call.context as unknown as LLMContext;
    const messages = call.context.messages;
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    const results = messages.slice(lastUser + 1).flatMap((m) => (m.role === 'toolResult' ? [m] : []));
    for (const message of results.slice(plan.results.length)) {
      const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const result: CallResult = { ok: !message.isError, text };
      const planned = plan.input.calls[plan.results.length];
      if (result.ok && planned !== undefined) captureInto(plan.vars, text, planned.capture);
      plan.results.push(result);
    }
    const next = plan.input.calls[results.length];
    if (next !== undefined) {
      const resolved = resolveTemplates(next, plan.vars);
      return { toolCalls: [{ name: resolved.tool, arguments: { action: resolved.action, ...(resolved.args ?? {}) } }] };
    }
    return resolveTemplates(plan.input.reply, plan.vars);
  }

  /**
   * Waits until the bridge's host-turn timeout has ended an abandoned
   * operator turn (checkpoint reports it settled), bounded by the timeout
   * and a margin for the donor to finish recording the failed turn.
   */
  async lapse(turnId: string): Promise<{ readonly settled: boolean; readonly waitedMs: number }> {
    const bridge = this.live().bridge;
    if (bridge === null) throw new Error('the lifecycle bridge is not mounted');
    const started = Date.now();
    while (Date.now() - started < HOST_TURN_TIMEOUT_MS + LAPSE_MARGIN_MS) {
      const answer = await bridge.checkpoint('hermes-operator', HERMES_TEST_INSTALL_ID, OPERATOR_SESSION, [turnId]);
      if (answer.ok && answer.value.settled.includes(turnId)) return { settled: true, waitedMs: Date.now() - started };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { settled: false, waitedMs: Date.now() - started };
  }

  /** The donor tool catalog Lite serves over MCP, and the tools the last Pi turn offered the model. */
  inventory(): { readonly catalog: readonly string[]; readonly offered: readonly string[] } {
    return { catalog: donorToolDefinitions(this.live().companion.agentLoop).map((tool) => tool.name), offered: this.lastOffered };
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    this.runtime = null;
  }
}
