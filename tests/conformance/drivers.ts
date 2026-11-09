/**
 * The Hermes-protocol driver for the TypeScript runner: what the Hermes
 * plugin sends, over the real transports. `prepare` and `settle` go to the
 * lifecycle bridge and every planned call goes through the MCP SDK client,
 * each with the bound principal's credential, so the donor agent loop runs the
 * calls inside the host-driven turn. Pi turns go to the host process
 * (`pi_turn`). The real plugin inside the pinned Hermes runs the same
 * scenarios in integrations/hermes/tests/test_conformance.py.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { HostProcess } from './host-client.ts';
import { OPERATOR_SESSION, type Principal } from './host/host.ts';
import { captureInto, observe, resolveTemplates, type CallResult, type CoreErrorShape, type PlannedCall, type RenderedContext, type TurnObservation, type Vars } from './scenario.ts';

export interface DriverTurn {
  readonly key: string;
  readonly as: Principal;
  readonly say: string;
  readonly calls: readonly PlannedCall[];
  readonly reply: string;
  readonly abandon: boolean;
  readonly vars: Vars;
}

/** The friend talks in its own Hermes session. */
const SESSION: Readonly<Record<Principal, string>> = { 'hermes-operator': OPERATOR_SESSION, 'hermes-friend': 'conformance-friend' };

export class HermesProtocolDriver {
  private clients = new Map<string, Client>();
  /** A Hermes process instance; a host that died is succeeded by a new one. */
  private instance = 1;

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
    return { ok: result.isError !== true, text: typeof payload['text'] === 'string' ? payload['text'] : JSON.stringify(payload) };
  }

  async turn(input: DriverTurn): Promise<TurnObservation> {
    const credential = this.urls.credentials[input.as];
    const hostInstance = `hermes-conformance-${String(this.instance)}`;
    const sessionId = SESSION[input.as];
    const prepared = await this.bridge('prepare', credential, { hostInstance, idempotencyKey: `hermes:${input.key}`, sessionId, message: input.say });
    if (prepared.status !== 200) return { turnId: null, refused: errorShape(prepared.body['error']), seen: '', speech: [], results: [] };
    if (prepared.body['kind'] !== 'prepared') throw new Error(`unexpected prepare answer ${JSON.stringify(prepared.body)}`);
    const turnId = prepared.body['turnId'] as string;
    const shown = observe(prepared.body['context'] as RenderedContext);
    if (input.abandon) {
      // The Hermes process died mid-turn: nothing settles the turn, and its successor is another process.
      this.instance += 1;
      return { turnId, refused: null, ...shown, results: [] };
    }
    const vars: Vars = { ...input.vars };
    const results: CallResult[] = [];
    for (const planned of input.calls) {
      const resolved = resolveTemplates(planned, vars);
      const result = await this.call(credential, resolved);
      if (result.ok) captureInto(vars, result.text, planned.capture);
      results.push(result);
    }
    const settled = await this.bridge('settle', credential, { hostInstance, turnId, outcome: { kind: 'completed', reply: resolveTemplates(input.reply, vars) } });
    if (settled.status !== 200 || settled.body['status'] !== 'completed') throw new Error(`settle did not complete the turn: ${JSON.stringify(settled.body)}`);
    return { turnId, refused: null, ...shown, results, vars };
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
  // An `unavailable` refusal names the capability that is busy or missing; the others carry a reason.
  const reason = error['reason'] ?? error['capability'];
  return { kind: String(error['kind']), ...(typeof reason === 'string' ? { reason } : {}) };
}
