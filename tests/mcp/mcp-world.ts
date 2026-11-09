/**
 * The MCP transport over a recording host tool port: the transport's own
 * behaviour (authentication, binding, rendering, error disclosure) without a
 * companion. The real port, the donor catalog inside host-driven turns, is
 * exercised end to end in tests/lifecycle.
 */
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach } from 'vitest';
import { createMcpSurface, loadPrincipalBindings, startMcpHttpServer, type McpErrorReport, type McpHttpServer } from '../../packages/mcp/src/index.ts';
import { recordingPort } from './fixtures/port.ts';

export { STORAGE_DETAIL, TOOLS, recordingPort, type PortCall } from './fixtures/port.ts';

const opened: McpHttpServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(opened.splice(0).map((s) => s.close()));
});

export const PRINCIPALS = ['robin', 'sam'] as const;

export async function mcpWorld() {
  const credentials = Object.fromEntries(PRINCIPALS.map((p) => [p, randomBytes(32).toString('base64url')])) as Record<(typeof PRINCIPALS)[number], string>;
  const env = Object.fromEntries(PRINCIPALS.map((p) => [`MCP_TEST_${p.toUpperCase()}`, credentials[p]]));
  const bindings = loadPrincipalBindings(PRINCIPALS.map((p) => ({ principal: p, credential: { env: `MCP_TEST_${p.toUpperCase()}` }, contact: p === 'robin' ? 'operator' : p })), env);
  if (!bindings.ok) throw new Error(JSON.stringify(bindings.error));
  const port = recordingPort();
  const reports: McpErrorReport[] = [];
  const surface = createMcpSurface({ port, identify: (c) => bindings.value.identify(c), onError: (r) => reports.push(r) });
  const server = await startMcpHttpServer({ surface, bindings: bindings.value, port: 0, onError: (r) => reports.push(r) });
  if (!server.ok) throw new Error(JSON.stringify(server.error));
  opened.push(server.value);
  return {
    url: server.value.url,
    credentials,
    port,
    reports,
    surface,
    async as(principal: (typeof PRINCIPALS)[number] | null, credential: string | null = principal === null ? null : credentials[principal]): Promise<Client> {
      return connectClient(server.value.url, credential);
    },
  };
}

export async function connectClient(url: string, credential: string | null): Promise<Client> {
  const client = new Client({ name: 'lite-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), credential === null ? {} : { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
  clients.push(client);
  return client;
}
