/**
 * A stdio MCP server process over the recording tool port, launched by the
 * stdio test. Bindings name environment variables; the test supplies the
 * values. Nothing is written to stdout except protocol messages.
 */
import { createMcpSurface, loadPrincipalBindings, startMcpStdioServer } from '../../../packages/mcp/src/index.ts';
import { recordingPort } from './port.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const bindings = loadPrincipalBindings(
  (['robin', 'sam'] as const).map((principal) => ({ principal, credential: { env: `STDIO_${principal.toUpperCase()}` }, contact: principal === 'robin' ? 'operator' : principal })),
  process.env,
);
if (!bindings.ok) fail(`bindings refused: ${JSON.stringify(bindings.error)}`);
const onError = (report: unknown) => process.stderr.write(`${JSON.stringify(report)}\n`);
const surface = createMcpSurface({ port: recordingPort(), identify: (c) => bindings.value.identify(c), onError });
const started = startMcpStdioServer({ surface, bindings: bindings.value, credential: { env: 'LITE_MCP_CREDENTIAL' }, env: process.env, onError });
if (!started.ok) fail(`stdio refused: ${JSON.stringify(started.error)}`);
