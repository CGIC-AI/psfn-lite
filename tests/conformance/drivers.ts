/**
 * Per-surface drivers for the TypeScript runner.
 *
 * - Pi: the host's own Pi harness runs the turn (`pi_turn`); the scripted
 *   companion makes the planned calls through the harness's Pi tools.
 * - Hermes protocol: what the Hermes plugin sends, over the real transports:
 *   `prepare` and `settle` on the lifecycle bridge and every planned call
 *   through the MCP SDK client, each with the bound principal's credential.
 *   This exercises Lite's side of the Hermes integration in vitest; the real
 *   plugin inside the pinned Hermes runs the same scenarios in
 *   integrations/hermes/tests/test_conformance.py.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { HostProcess } from './host-client.ts';
import type { Principal } from './host/host.ts';
import { canonical, captureInto, resolveTemplates, type CallResult, type CoreErrorShape, type PlannedCall, type TurnObservation, type Vars } from './scenario.ts';

export interface DriverTurn {
  readonly key: string;
  readonly as: Principal;
  readonly say: string;
  readonly calls: readonly PlannedCall[];
  readonly reply: string;
  readonly abandon: boolean;
  readonly vars: Vars;
}

interface ContextEntry {
  readonly role: string;
  readonly label: string | null;
  readonly origin: string;
  readonly text: string;
}

export class HermesProtocolDriver {
  private clients = new Map<string, Client>();
  /** A Hermes process instance; a host that died is succeeded by a new one. */
  private instance = 1;
  /** Set by the runner while the Lite host is being replaced after a crash. */
  hostSwap: Promise<void> = Promise.resolve();

  constructor(private readonly host: () => HostProcess) {}

  private get urls() {
    return this.host().ready;
  }

  async bridge(route: string, credential: string, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const response = await fetch(`${this.urls.lifecycleUrl}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async client(credential: string): Promise<Client> {
    const existing = this.clients.get(credential);
    if (existing !== undefined) return existing;
    const client = new Client({ name: 'hermes-conformance', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(this.urls.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
    this.clients.set(credential, client);
    return client;
  }

  async call(credential: string, call: PlannedCall): Promise<CallResult> {
    const client = await this.client(credential);
    const result = await client.callTool({ name: call.tool, arguments: { action: call.action, ...(call.args ?? {}) } });
    const payload = (result.structuredContent ?? {}) as Record<string, unknown>;
    if (result.isError === true) return { ok: false, error: errorShape(payload['error']) };
    return { ok: true, content: payload['content'] };
  }

  async turn(input: DriverTurn): Promise<TurnObservation> {
    const credential = this.urls.credentials[input.as];
    const hostInstance = `hermes-conformance-${String(this.instance)}`;
    const prepared = await this.bridge('prepare', credential, { hostInstance, idempotencyKey: `hermes:${input.key}`, message: input.say });
    if (prepared.status !== 200) return { turnId: null, refused: errorShape(prepared.body['error']), seen: '', speech: [], results: [] };
    if (prepared.body['kind'] !== 'prepared') throw new Error(`unexpected prepare answer ${JSON.stringify(prepared.body)}`);
    const turnId = prepared.body['turnId'] as string;
    const context = prepared.body['context'] as { readonly history: readonly ContextEntry[] } & Record<string, unknown>;
    // Hermes shows the participant's message itself, as the user turn; Lite's context precedes it.
    const seen = `${JSON.stringify(context)}\n${input.say}`;
    const speech = [...context.history.filter((e) => e.role === 'participant' && e.origin === 'participant_speech').map((e) => e.text), input.say];
    if (input.abandon) {
      // The Hermes process died mid-turn: nothing settles the turn, and its successor is another process.
      this.instance += 1;
      return { turnId, refused: null, seen, speech, results: [] };
    }
    const vars: Vars = { ...input.vars };
    const results: CallResult[] = [];
    for (const planned of input.calls) {
      const resolved = resolveTemplates(planned, vars);
      let result: CallResult;
      try {
        result = await this.call(credential, resolved);
      } catch (error) {
        // The Lite host died under the call (a crash step): Hermes sees a tool error, and its turn goes on to settle.
        await this.hostSwap;
        await this.reset();
        results.push({ ok: false, error: { kind: 'transport', reason: error instanceof Error ? error.message : String(error) } });
        break;
      }
      if (result.ok) captureInto(vars, canonical(result.content), planned.capture);
      results.push(result);
    }
    const settled = await this.bridge('settle', credential, {
      hostInstance,
      turnId,
      outcome: { kind: 'completed', reply: resolveTemplates(input.reply, vars), delivery: 'unknown' },
      toolCallCount: input.calls.length,
    });
    if (settled.status !== 200) throw new Error(`settle refused: ${JSON.stringify(settled.body)}`);
    return { turnId, refused: null, seen, speech, results, vars };
  }

  /**
   * Serves delegated internal turns while `during` runs (a scheduler tick):
   * claims each job as the configured internal-turn host, prepares it with
   * the minted credential, answers a free-time invitation per the plan over
   * MCP with that credential, and settles with the reflection.
   */
  async serveInternalTurns<T>(plan: { readonly choice: string; readonly reflection: string }, during: Promise<T>): Promise<{ readonly result: T; readonly jobs: readonly string[] }> {
    const operator = this.urls.credentials['hermes-operator'];
    const tick = { done: false };
    const jobs: string[] = [];
    const finished = during.finally(() => {
      tick.done = true;
    });
    const serving = (async () => {
      while (!tick.done) {
        const claim = await this.bridge('internal/claim', operator, { waitMs: 500 });
        const job = claim.body['job'] as { jobId: string; credential: string; purpose: string; prompt: string } | null | undefined;
        if (job === null || job === undefined) continue;
        jobs.push(job.purpose);
        const turn = await this.bridge('prepare', job.credential, { hostInstance: 'hermes-internal', idempotencyKey: 'ignored', message: null });
        if (turn.status !== 200) throw new Error(`internal prepare refused: ${JSON.stringify(turn.body)}`);
        const turnId = turn.body['turnId'] as string;
        if (plan.choice === 'release') {
          await this.bridge('internal/release', operator, { jobId: job.jobId, error: { code: 'hermes_runner_failed', message: 'the internal-turn process exited with status 1' } });
          continue;
        }
        const block = /\(blockId (\S+)\)/.exec(job.prompt)?.[1];
        let calls = 0;
        if (block !== undefined) {
          const decision: PlannedCall =
            plan.choice === 'rest'
              ? { tool: 'free_time', action: 'rest', args: { blockId: block } }
              : plan.choice === 'defer'
                ? { tool: 'free_time', action: 'defer', args: { blockId: block, minutes: 240 } }
                : { tool: 'free_time', action: 'choose', args: { blockId: block, optionId: plan.choice } };
          const chose = await this.call(job.credential, decision);
          if (!chose.ok) throw new Error(`internal free-time decision refused: ${JSON.stringify(chose.error)}`);
          calls = 1;
          await this.clients.get(job.credential)?.close();
          this.clients.delete(job.credential);
        }
        const reply = block === undefined ? plan.reflection : 'That is my choice.';
        const settled = await this.bridge('settle', job.credential, { hostInstance: 'hermes-internal', turnId, outcome: { kind: 'completed', reply, delivery: 'unknown' }, toolCallCount: calls });
        if (settled.status !== 200) throw new Error(`internal settle refused: ${JSON.stringify(settled.body)}`);
      }
    })();
    const [result] = await Promise.all([finished, serving]);
    return { result, jobs };
  }

  /** Forget connections after the host restarted or was replaced. */
  async reset(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients = new Map();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

function errorShape(raw: unknown): CoreErrorShape {
  if (typeof raw !== 'object' || raw === null) return { kind: 'unknown' };
  const error = raw as Record<string, unknown>;
  const reason = error['reason'] ?? error['capability'];
  return { kind: String(error['kind']), ...(typeof reason === 'string' ? { reason } : {}) };
}
