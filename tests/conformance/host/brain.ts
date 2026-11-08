/**
 * The scripted model of the conformance host, over pi-ai's faux provider.
 * Nothing here decides what Lite does: the brain only stands in for the
 * companion's (and a worker's, and the machine tasks') model, following the
 * plan the current scenario step set. The companion's participant turn
 * makes the step's planned tool calls in order and then replies; free-time
 * invitations are answered from the free-time plan; a worker follows the
 * worker plan; memory extraction proposes exactly the items the step named.
 * A plan may also hang, so a runner can kill the host mid-call.
 */
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { AFFECT_JSON, callTool, fauxRuntime, providerError, say, type BrainCall } from '../../pi/faux-brain.ts';
import { captureInto, resolveTemplates, type CallResult, type PlannedCall, type Vars } from '../scenario.ts';

export interface TurnPlan {
  readonly calls: readonly PlannedCall[];
  readonly reply: string;
  /** The companion's first model call never returns. */
  readonly hang: boolean;
  readonly vars: Vars;
}

export interface FreeTimePlan {
  /** reflect | wander | resume:<id> (choose), rest, defer, fail (the provider errors), ignore (no decision). */
  readonly choice: string;
  readonly reflection: string;
}

export interface WorkerPlan {
  readonly calls: readonly PlannedCall[];
  readonly reply: string;
  /** `first`: the worker's first model call never returns; `after_calls`: the call after its planned calls never returns. */
  readonly hang: 'first' | 'after_calls' | 'never';
}

export interface ExtractionItem {
  /** A participant turn whose text contains this. */
  readonly from: string;
  readonly kind: string;
  readonly content: string;
  readonly sensitivity: string;
  readonly about: 'speaker' | 'room';
  readonly attribution: 'participant_attributed' | 'inferred';
}

/** Emitted when a scripted model call hangs, so a runner kills the host while that call is in flight. */
export type BrainEvent = 'companion_hang' | 'worker_hang';

export class ScriptedModel {
  companion: TurnPlan | null = null;
  freeTime: FreeTimePlan = { choice: 'rest', reflection: 'A quiet thought.' };
  worker: WorkerPlan = { calls: [], reply: 'Worker finished.', hang: 'never' };
  /** Canonical results of the tool calls the last worker request carried: what the worker was shown. */
  workerResults: readonly CallResult[] = [];
  extraction: readonly ExtractionItem[] = [];
  readonly runtime;
  readonly calls: BrainCall[];

  constructor(private readonly onEvent: (event: BrainEvent) => void) {
    const model = fauxRuntime((call) => this.answer(call));
    this.runtime = model.runtime;
    this.calls = model.calls;
  }

  /** Model calls so far, by kind. */
  counts(): Record<BrainCall['kind'], number> {
    const out = { estimator: 0, inference: 0, worker: 0, companion: 0 };
    for (const call of this.calls) out[call.kind] += 1;
    return out;
  }

  private answer(call: BrainCall): AssistantMessage | Promise<AssistantMessage> {
    switch (call.kind) {
      case 'estimator':
        return say(AFFECT_JSON);
      case 'inference':
        return call.systemPrompt.startsWith('Task: memory_extraction') ? say(this.extract(call.lastUser)) : say('A short machine appraisal of the turn.');
      case 'worker': {
        const results = toolResults(call.context);
        this.workerResults = results;
        const hang = this.worker.hang === 'first' || (this.worker.hang === 'after_calls' && results.length >= this.worker.calls.length);
        if (hang) return this.hang('worker_hang');
        return this.follow(this.worker.calls, this.worker.reply, call, {});
      }
      case 'companion':
        return this.companionAnswer(call);
    }
  }

  private companionAnswer(call: BrainCall): AssistantMessage | Promise<AssistantMessage> {
    const invitation = /Free time is open[\s\S]*?\(blockId (\S+)\)/.exec(call.lastUser);
    if (invitation?.[1] !== undefined) {
      if (call.afterTool) return say('That is my choice.');
      const blockId = invitation[1];
      const choice = this.freeTime.choice;
      if (choice === 'fail') return providerError('provider unavailable during free time');
      if (choice === 'ignore') return say('Not now.');
      if (choice === 'rest') return callTool('free_time', 'rest', { blockId });
      if (choice === 'defer') return callTool('free_time', 'defer', { blockId, minutes: 240 });
      return callTool('free_time', 'choose', { blockId, optionId: choice });
    }
    if (call.lastUser.includes('Your free time (block')) return say(this.freeTime.reflection);
    const plan = this.companion;
    if (plan === null) return say('ok');
    if (plan.hang) return this.hang('companion_hang');
    return this.follow(plan.calls, plan.reply, call, plan.vars);
  }

  /** A provider call that never answers; the runner kills the host while it is in flight. */
  private hang(event: BrainEvent): Promise<AssistantMessage> {
    this.onEvent(event);
    return new Promise<AssistantMessage>(() => undefined);
  }

  /** The next planned call after the results already in this request, or the reply once all were made. */
  private follow(calls: readonly PlannedCall[], reply: string, call: BrainCall, vars: Vars): AssistantMessage {
    const results = toolResults(call.context);
    const local: Vars = { ...vars };
    results.forEach((result, i) => {
      const planned = calls[i];
      if (planned !== undefined && result.ok) captureInto(local, JSON.stringify(result.content), planned.capture);
    });
    const next = calls[results.length];
    if (next === undefined) return say(resolveTemplates(reply, local));
    const resolved = resolveTemplates(next, local);
    return callTool(resolved.tool, resolved.action, { ...(resolved.args ?? {}) });
  }

  /** The planned extraction items whose source turn is in this transcript. */
  private extract(transcript: string): string {
    const turns: { turnId: string; participant: boolean; text: string }[] = [];
    const pattern = /(?:^|\n\n)\[transcript turn (\S+) \((participant [^)]+|companion)\)\]\n([\s\S]*?)(?=\n\n\[|$)/g;
    for (const m of transcript.matchAll(pattern)) {
      if (m[1] !== undefined && m[2] !== undefined && m[3] !== undefined) turns.push({ turnId: m[1], participant: m[2] !== 'companion', text: m[3] });
    }
    const memories = this.extraction.flatMap((item) => {
      const source = turns.find((t) => t.participant && t.text.includes(item.from));
      if (source === undefined) return [];
      return [{ turnId: source.turnId, kind: item.kind, content: item.content, sensitivity: item.sensitivity, about: item.about, attribution: item.attribution, confidence: 0.8 }];
    });
    return JSON.stringify({ memories });
  }
}

/** Results of the tool calls in this request, oldest first: core content, or core's refusal as the Pi harness labels it. */
export function toolResults(context: Context): CallResult[] {
  const out: CallResult[] = [];
  for (const message of context.messages) {
    if (message.role !== 'toolResult') continue;
    const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    if (message.isError) {
      const refused = /was refused: (\w+)(?: \(([^)]+)\))?/.exec(text);
      out.push({ ok: false, error: refused?.[1] === undefined ? { kind: 'unknown' } : { kind: refused[1], ...(refused[2] === undefined ? {} : { reason: refused[2] }) } });
      continue;
    }
    try {
      out.push({ ok: true, content: JSON.parse(text) as unknown });
    } catch {
      out.push({ ok: true, content: text });
    }
  }
  return out;
}
