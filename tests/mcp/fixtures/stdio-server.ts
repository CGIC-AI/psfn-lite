/**
 * A stdio MCP server process over the fake activity world, launched by the
 * stdio test. Bindings name environment variables; the test supplies the
 * values. Nothing is written to stdout except protocol messages.
 */
import { BASELINE_DISCLOSURE_POLICY, createContactAuthority, createTrustedIngress } from '../../../packages/core/src/index.ts';
import { createMcpSurface, loadPrincipalBindings, startMcpStdioServer } from '../../../packages/mcp/src/index.ts';
import { fakeActivityWorld } from '../../core/activity-world.ts';
import { COMPANION } from '../../core/fakes.ts';
import { BINDINGS } from '../bindings-fixture.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const world = await fakeActivityWorld();
const config = {
  bindings: (['primary', 'friend'] as const).map((principal) => ({ principal, credential: { env: `STDIO_${principal.toUpperCase()}` }, attestation: BINDINGS[principal] })),
};
const bindings = loadPrincipalBindings(config, process.env);
if (!bindings.ok) fail(`bindings refused: ${JSON.stringify(bindings.error)}`);
const ingress = createTrustedIngress({
  companionId: COMPANION,
  authenticator: bindings.value.authenticator,
  contacts: createContactAuthority(world.contactStore),
  policy: BASELINE_DISCLOSURE_POLICY,
});
if (!ingress.ok) fail('ingress refused');
const onError = (report: unknown) => process.stderr.write(`${JSON.stringify(report)}\n`);
const surface = createMcpSurface({ dispatcher: world.dispatcher, ingress: ingress.value, onError });
if (!surface.ok) fail('surface refused');
const started = startMcpStdioServer({ surface: surface.value, bindings: bindings.value, credential: { env: 'LITE_MCP_CREDENTIAL' }, env: process.env, onError });
if (!started.ok) fail(`stdio refused: ${JSON.stringify(started.error)}`);
