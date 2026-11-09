/**
 * Host-driven turns over the extracted companion core.
 *
 * A host that runs its own model loop (Hermes) still gets a companion turn
 * that is the donor's: the bridge calls `SubstrateAgent.handleMessage`, and
 * the model calls of that turn are answered by the host instead of a
 * provider. The donor gave its foreground turn exactly one model seam, the
 * stream transport (donor core-runtime.ts:724-726 passed the remote process's
 * `stream` there); this relay wraps the in-process default transport and
 * answers only the calls of the turns it opened, recognised by the request id
 * the donor stamps on every call's correlation (`message.id`). Every other
 * call (internal turns, background lanes) goes to the default transport.
 *
 * So the host's turn gets, by construction, the donor's context assembly (the
 * first model call's system prompt, history and tools are what `prepare`
 * returns), its tool execution (a host tool call is answered to the donor's
 * loop as the model's tool call; the donor runs the tool with its gates and
 * returns the result in the next call's context), its archive and its
 * post-turn work (the donor records and schedules them when the host's final
 * reply ends its loop). What a host-driven turn cannot reproduce is recorded
 * in docs/extraction.md (Step C).
 */
import {
  NonRecoverableFallbackError,
  type AgentResponse,
  type LLMContext,
  type LLMProviderStreamOptions,
  type LLMResponse,
  type StreamCallbacks,
  type SubstrateMessage,
  type SubstrateStreamTransport,
} from './companion.ts';

/** The part of the donor's SubstrateAgent a host-driven turn uses. */
export interface HostTurnAgent {
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
  abort(expectedRequestId?: string): { readonly status: string };
  hasRecordedSourceMessage(channelId: string, sourceMessageId: string): boolean;
}

/** One message of the context the donor assembled for the model, as the host renders it. */
export interface HostContextMessage {
  readonly role: 'user' | 'assistant' | 'tool_result';
  readonly text: string;
  /** The donor's message class (system note, internal whisper, compaction, ...), when it set one. */
  readonly messageClass?: string;
  readonly toolName?: string;
}

export interface HostToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The donor's assembled model request for the turn. */
export interface HostTurnContext {
  readonly systemPrompt: string;
  readonly messages: readonly HostContextMessage[];
  readonly tools: readonly HostToolSchema[];
}

export type HostTurnEnd =
  | { readonly kind: 'response'; readonly response: AgentResponse }
  | { readonly kind: 'error'; readonly error: Error };

export type ToolRelayResult =
  | { readonly kind: 'result'; readonly text: string; readonly isError: boolean }
  /** The donor's loop ended without running the call (step budget, a no-reply decision, an abort). */
  | { readonly kind: 'turn_ended'; readonly end: HostTurnEnd };

interface PendingCall {
  readonly context: LLMContext;
  resolve(response: LLMResponse): void;
  reject(error: Error): void;
}

const HOST_MODEL = 'host';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const block = part as { type?: unknown; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/** The donor transport context carries the pi-ai messages the agent loop built (user, assistant, toolResult). */
export function hostContextOf(context: LLMContext): HostTurnContext {
  const messages: HostContextMessage[] = [];
  for (const raw of context.messages as readonly unknown[]) {
    const message = raw as { role?: unknown; content?: unknown; messageClass?: unknown; toolName?: unknown };
    const messageClass = typeof message.messageClass === 'string' ? { messageClass: message.messageClass } : {};
    if (message.role === 'user' || message.role === 'assistant') {
      const text = textOf(message.content);
      if (text !== '') messages.push({ role: message.role, text, ...messageClass });
    } else if (message.role === 'toolResult') {
      messages.push({
        role: 'tool_result',
        text: textOf(message.content),
        ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
      });
    }
  }
  const tools = ((context.tools ?? []) as readonly unknown[]).map((raw) => {
    const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; parameters?: unknown };
    const schema = (tool.inputSchema ?? tool.parameters ?? {}) as Record<string, unknown>;
    return { name: String(tool.name), description: typeof tool.description === 'string' ? tool.description : '', inputSchema: schema };
  });
  return { systemPrompt: context.systemPrompt, messages, tools };
}

function toolResultOf(context: LLMContext, toolCallId: string): { text: string; isError: boolean } | null {
  for (const raw of context.messages as readonly unknown[]) {
    const message = raw as { role?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown };
    if (message.role === 'toolResult' && message.toolCallId === toolCallId) {
      return { text: textOf(message.content), isError: message.isError === true };
    }
  }
  return null;
}

function response(content: string, toolCalls: LLMResponse['toolCalls'], stopReason: 'stop' | 'toolUse'): LLMResponse {
  return { content, toolCalls, model: HOST_MODEL, inputTokens: 0, outputTokens: 0, stopReason };
}

/** One open host-driven turn. Host actions on it are serialized. */
export class HostTurn {
  readonly requestId: string;
  readonly turnId: string;
  readonly channelId: string;
  readonly owner: string;
  readonly openedAt: number;
  /** The context of the first model call: what `prepare` hands the host. */
  readonly context: HostTurnContext;
  toolCallCount = 0;
  private pending: PendingCall | null = null;
  private waiters: (() => void)[] = [];
  private ended = false;
  private answered = false;
  private interruptRequested = false;
  private chain: Promise<unknown> = Promise.resolve();
  private endValue: HostTurnEnd | null = null;
  private readonly endPromise: Promise<HostTurnEnd>;

  constructor(init: { requestId: string; turnId: string; channelId: string; owner: string; done: Promise<HostTurnEnd>; context: HostTurnContext; now: number }) {
    this.requestId = init.requestId;
    this.turnId = init.turnId;
    this.channelId = init.channelId;
    this.owner = init.owner;
    this.openedAt = init.now;
    this.context = init.context;
    this.endPromise = init.done;
  }

  /** @internal The relay hands every model call of this turn to the turn. */
  accept(call: PendingCall): void {
    if (this.answered) {
      // The donor asked for another completion after the host's final reply
      // (a corrective re-prompt). The host turn has ended on the host's side,
      // so there is nobody to ask; the donor records the call's failure.
      call.reject(new NonRecoverableFallbackError(new Error('host-driven turn already answered; no further model call can be served')));
      return;
    }
    this.pending = call;
    this.wake();
  }

  /** @internal */
  markEnded(end: HostTurnEnd): void {
    this.ended = true;
    this.endValue = end;
    this.wake();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** True once the host interrupted the turn (set before the donor run is aborted). */
  get wasInterrupted(): boolean {
    return this.interruptRequested;
  }

  end(): Promise<HostTurnEnd> {
    return this.endPromise;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** The suspended model call, once the donor makes one; null once the turn ended. */
  private async nextCall(): Promise<PendingCall | null> {
    for (;;) {
      if (this.pending !== null) {
        const call = this.pending;
        this.pending = null;
        return call;
      }
      if (this.ended) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Answers the donor's pending model call with the host's tool call and returns the donor's tool result. */
  callTool(name: string, input: Record<string, unknown>): Promise<ToolRelayResult> {
    return this.serial(async () => {
      const call = this.answered ? null : await this.nextCall();
      if (call === null) return { kind: 'turn_ended', end: await this.endPromise };
      this.toolCallCount += 1;
      const id = `host_call_${this.toolCallCount}`;
      call.resolve(response('', [{ id, name, input }], 'toolUse'));
      const next = await this.nextCall();
      if (next === null) return { kind: 'turn_ended', end: await this.endPromise };
      // Keep the donor waiting on this call for the host's next action.
      this.pending = next;
      const result = toolResultOf(next.context, id);
      return result === null
        ? { kind: 'result', text: 'The companion runtime returned no result for this tool call.', isError: true }
        : { kind: 'result', ...result };
    });
  }

  /** The host's final reply ends the donor's loop; the donor then records the turn and its post-turn work. */
  complete(reply: string): Promise<HostTurnEnd> {
    return this.serial(async () => {
      const call = this.answered ? null : await this.nextCall();
      this.answered = true;
      call?.resolve(response(reply, [], 'stop'));
      return this.endPromise;
    });
  }

  /** The host's turn failed: the donor's model call fails without a retry, and the donor records the failure. */
  fail(code: string): Promise<HostTurnEnd> {
    return this.serial(async () => {
      const call = this.answered ? null : await this.nextCall();
      this.answered = true;
      call?.reject(new NonRecoverableFallbackError(new Error(`host-driven turn failed: ${code}`)));
      return this.endPromise;
    });
  }

  /** The host's turn was interrupted: the donor's run is aborted, as a caller cancellation. */
  interrupt(agent: HostTurnAgent): Promise<HostTurnEnd> {
    this.interruptRequested = true;
    return this.serial(async () => {
      this.answered = true;
      agent.abort(this.requestId);
      const call = this.pending;
      this.pending = null;
      call?.reject(new NonRecoverableFallbackError(new Error('host-driven turn interrupted'), { callerCancelled: true }));
      return this.endPromise;
    });
  }

  /** @internal The end value once known (for status reads without awaiting). */
  get endedWith(): HostTurnEnd | null {
    return this.endValue;
  }
}

export type OpenOutcome =
  | { readonly kind: 'open'; readonly turn: HostTurn }
  /** The donor's turn ended before any model call (for example a recorded duplicate or a refused turn). */
  | { readonly kind: 'ended'; readonly end: HostTurnEnd; readonly turnId: string };

export interface HostTurnRelayOptions {
  readonly now?: () => number;
}

/** The registry of open host-driven turns and the transport that serves their model calls. */
export class HostTurnRelay {
  private agent: HostTurnAgent | null = null;
  private readonly turns = new Map<string, HostTurn>();
  private readonly starting = new Map<string, (call: PendingCall) => void>();
  private readonly now: () => number;

  constructor(options: HostTurnRelayOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Wraps the default transport (pass as `wrapStreamTransport` to `startCompanionRuntime`). */
  readonly wrapTransport = (base: SubstrateStreamTransport): SubstrateStreamTransport => ({
    stream: (context: LLMContext, callbacks?: StreamCallbacks, options?: LLMProviderStreamOptions): Promise<LLMResponse> => {
      const requestId = context.correlation?.requestId;
      const turn = requestId === undefined ? undefined : this.turns.get(requestId);
      const starting = requestId === undefined ? undefined : this.starting.get(requestId);
      if (turn === undefined && starting === undefined) {
        return options === undefined ? base.stream(context, callbacks) : base.stream(context, callbacks, options);
      }
      return new Promise<LLMResponse>((resolve, reject) => {
        const signal = options?.signal;
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          reject(new NonRecoverableFallbackError(new Error('host-driven turn aborted'), { callerCancelled: true }));
        };
        const call: PendingCall = {
          context,
          resolve: (value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        };
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        if (turn !== undefined) turn.accept(call);
        else starting?.(call);
      });
    },
  });

  /** Binds the relay to the started runtime's agent. */
  attach(agent: HostTurnAgent): void {
    this.agent = agent;
  }

  private requireAgent(): HostTurnAgent {
    if (this.agent === null) throw new Error('host-driven turns need a started companion runtime');
    return this.agent;
  }

  get(requestId: string): HostTurn | undefined {
    return this.turns.get(requestId);
  }

  /** The open turns, oldest first. */
  open(): readonly HostTurn[] {
    return [...this.turns.values()];
  }

  hasRecorded(channelId: string, requestId: string): boolean {
    return this.requireAgent().hasRecordedSourceMessage(channelId, requestId);
  }

  /**
   * Starts the donor's turn for `message` and waits for its first model call
   * (the assembled context) or its end. `message.routing.turnId` must be set,
   * so the host knows the turn id before the donor records anything.
   */
  async begin(message: SubstrateMessage, owner: string): Promise<OpenOutcome> {
    const agent = this.requireAgent();
    const turnId = message.routing?.turnId;
    if (turnId === undefined) throw new Error('a host-driven turn needs a turn id');
    if (this.turns.has(message.id) || this.starting.has(message.id)) throw new Error('this host-driven turn is already open');
    let first: (call: PendingCall) => void = () => undefined;
    const firstCall = new Promise<PendingCall>((resolve) => {
      first = resolve;
    });
    this.starting.set(message.id, (call) => first(call));
    let turn: HostTurn | null = null;
    const done: Promise<HostTurnEnd> = agent.handleMessage(message).then(
      (value): HostTurnEnd => ({ kind: 'response', response: value }),
      (error: unknown): HostTurnEnd => ({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) }),
    );
    const ended = done.then((end) => ({ end }));
    try {
      const raced = await Promise.race([firstCall.then((call) => ({ call })), ended]);
      if ('end' in raced) return { kind: 'ended', end: raced.end, turnId };
      const created: HostTurn = new HostTurn({
        requestId: message.id,
        turnId,
        channelId: message.channelId,
        owner,
        done,
        context: hostContextOf(raced.call.context),
        now: this.now(),
      });
      turn = created;
      this.turns.set(message.id, created);
      created.accept(raced.call);
      void done.then((end) => {
        created.markEnded(end);
        if (this.turns.get(message.id) === created) this.turns.delete(message.id);
      });
      return { kind: 'open', turn: created };
    } finally {
      this.starting.delete(message.id);
      if (turn === null) {
        // Ended before a model call: nothing stays registered.
        this.turns.delete(message.id);
      }
    }
  }
}
