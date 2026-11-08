/**
 * The TypeScript conformance runner: one scenario, one order of surfaces.
 * Pi steps and host operations go to the host process; Hermes steps go
 * through the Hermes-protocol driver; `crash` kills the host process and
 * starts a successor over the same state. Every failed expectation is
 * collected with its step, so one run reports everything it saw.
 */
import { HermesProtocolDriver } from './drivers.ts';
import { HostProcess } from './host-client.ts';
import type { HostState } from './host/host.ts';
import {
  canonical,
  captureInto,
  checkResult,
  checkTurn,
  resolveTemplates,
  surfaceOf,
  type CallResult,
  type Order,
  type Scenario,
  type TurnObservation,
  type TurnStep,
  type Vars,
} from './scenario.ts';

export interface RunReport {
  readonly issues: readonly string[];
  readonly vars: Vars;
}

export async function runScenario(scenario: Scenario, order: Order, initial: HostState): Promise<RunReport> {
  let host = await HostProcess.start(initial);
  const hermes = new HermesProtocolDriver(() => host);
  const vars: Vars = { ...host.ready.vars };
  const issues: string[] = [];
  const label = `${scenario.name} [a=${order.a}, b=${order.b}]`;

  const relaunch = async (state: HostState) => {
    const swap = (async () => {
      await hermes.reset();
      host = await HostProcess.start({ ...state, generation: state.generation + 1 });
    })();
    hermes.hostSwap = swap;
    await swap;
  };

  try {
    for (const step of scenario.steps) {
      const at = `${label} ${step.id}`;
      if (step.do === 'crash') {
        await relaunch(await host.kill());
        continue;
      }
      if (step.do === 'host') {
        const args = resolveTemplates(step.args ?? {}, vars);
        let result: CallResult;
        if (step.op === 'tick' && scenario.internalTurns === 'delegated') {
          const plan = { choice: String(args['choice'] ?? 'rest'), reflection: String(args['reflection'] ?? 'A quiet thought.') };
          const served = await hermes.serveInternalTurns(plan, host.request('tick', args));
          result = { ok: true, content: { ...(served.result as Record<string, unknown>), delegatedJobs: served.jobs } };
        } else if (step.op === 'dispatch') {
          result = await host.request<CallResult>('dispatch', args);
        } else {
          result = { ok: true, content: await host.request(step.op, args) };
        }
        if (step.op === 'restart' || step.op === 'backup_restore') await hermes.reset();
        issues.push(...checkResult(step.expect, result, at));
        if (result.ok) captureInto(vars, canonical(result.content), step.capture);
        continue;
      }
      const observed = await runTurn(step, order, vars, host, hermes, () => relaunchAfterAbandon());
      Object.assign(vars, observed.vars ?? {});
      issues.push(...checkTurn(resolveTemplates(step, vars), observed, at));
      if (observed.turnId !== null) vars[`turn.${step.id}`] = observed.turnId;
    }
  } finally {
    await hermes.reset();
    await host.close();
  }
  return { issues, vars };

  async function relaunchAfterAbandon() {
    await relaunch(await host.kill());
  }
}

async function runTurn(
  step: TurnStep,
  order: Order,
  vars: Vars,
  host: HostProcess,
  hermes: HermesProtocolDriver,
  crash: () => Promise<void>,
): Promise<TurnObservation> {
  const surface = surfaceOf(step.on, order);
  const say = resolveTemplates(step.say, vars);
  const calls = step.calls ?? [];
  const reply = step.reply ?? 'ok';
  const key = `${step.id}-${surface}`;
  if (step.crash === 'worker') {
    // The worker the turn spawns is mid model call when the Lite host dies; whatever the turn returns is lost with it.
    const started = host.nextEvent('worker_model_call');
    const turn =
      surface === 'hermes'
        ? hermes.turn({ key, as: 'hermes-operator', say, calls, reply, abandon: false, vars }).catch(() => null)
        : host.request<TurnObservation>('pi_turn', { say, calls, reply, hang: false, vars, key }).catch(() => null);
    await started;
    await crash();
    const observed = await turn;
    return observed ?? { turnId: null, refused: null, seen: '', speech: [], results: [] };
  }
  if (surface === 'hermes') {
    return hermes.turn({ key, as: step.as === 'friend' ? 'hermes-friend' : 'hermes-operator', say, calls, reply, abandon: step.abandon === true, vars });
  }
  if (step.abandon === true) {
    // The Pi host dies while the companion's model call is in flight: kill the process, start a successor.
    const started = host.nextEvent('companion_model_call');
    const turn = host.request('pi_turn', { say, calls, reply, hang: true, vars, key }).catch(() => null);
    await started;
    await crash();
    await turn;
    return { turnId: null, refused: null, seen: '', speech: [], results: [] };
  }
  return host.request<TurnObservation>('pi_turn', { say, calls, reply, hang: false, vars, key });
}
