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
import { canonical, captureInto, checkResult, checkTurn, resolveTemplates, surfaceOf, type Order, type Scenario, type TurnObservation, type TurnStep, type Vars } from './scenario.ts';

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

  try {
    for (const step of scenario.steps) {
      const at = `${label} ${step.id}`;
      if (step.do === 'crash') {
        const state = await host.kill();
        await hermes.reset();
        host = await HostProcess.start({ ...state, generation: state.generation + 1 });
        continue;
      }
      if (step.do === 'host') {
        const text = canonical(await host.request(step.op, resolveTemplates(step.args ?? {}, vars)));
        issues.push(...checkResult(step.expect, { ok: true, text }, at));
        captureInto(vars, text, step.capture);
        continue;
      }
      const observed = await runTurn(step, order, vars, host, hermes);
      Object.assign(vars, observed.vars ?? {});
      issues.push(...checkTurn(resolveTemplates(step, vars), observed, at));
      if (observed.turnId !== null) vars[`turn.${step.id}`] = observed.turnId;
    }
  } finally {
    await hermes.reset();
    await host.close();
  }
  return { issues, vars };
}

function runTurn(step: TurnStep, order: Order, vars: Vars, host: HostProcess, hermes: HermesProtocolDriver): Promise<TurnObservation> {
  const surface = surfaceOf(step.on, order);
  const say = resolveTemplates(step.say, vars);
  const calls = step.calls ?? [];
  const reply = step.reply ?? 'ok';
  const key = `${step.id}-${surface}`;
  if (surface === 'hermes') {
    return hermes.turn({ key, as: step.as === 'friend' ? 'hermes-friend' : 'hermes-operator', say, calls, reply, abandon: step.abandon === true, vars });
  }
  return host.request<TurnObservation>('pi_turn', { say, calls, reply, vars, key });
}
