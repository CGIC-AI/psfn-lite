/**
 * The stdio transport in a real child process, driven by the SDK's stdio
 * client: the process's credential selects its binding, every call is still
 * admitted through core ingress, and an unbound credential stops startup
 * without echoing it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_INVENTORY } from '../../packages/core/src/index.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'stdio-server.ts');
const ARGS = ['--import', 'tsx', FIXTURE];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function credentials() {
  return { primary: randomBytes(32).toString('base64url'), friend: randomBytes(32).toString('base64url') };
}

function environment(creds: ReturnType<typeof credentials>, presented: string): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', STDIO_PRIMARY: creds.primary, STDIO_FRIEND: creds.friend, LITE_MCP_CREDENTIAL: presented };
}

describe('stdio transport', () => {
  it('serves the inventory to the bound principal of the process', async () => {
    const creds = credentials();
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ARGS, env: environment(creds, creds.friend), stderr: 'pipe' }));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_INVENTORY.map((t) => t.name));

    const written = await client.callTool({ name: 'memory', arguments: { action: 'write', writeId: 'w-1', kind: 'fact', content: 'Sam keeps a sourdough starter', sensitivity: 'personal' } });
    expect(written.isError).not.toBe(true);
    const found = await client.callTool({ name: 'memory', arguments: { action: 'search', query: 'sourdough' } });
    expect(JSON.stringify(found.structuredContent)).toContain('sourdough');
    // The process is Sam's: the companion-private reflection list stays closed to it.
    const denied = await client.callTool({ name: 'journal', arguments: { action: 'reflections_list' } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ error: { kind: 'denied', reason: 'audience_not_admitted' } });
  }, 30_000);

  it('refuses to start with an unbound credential and does not echo it', () => {
    const creds = credentials();
    const presented = randomBytes(32).toString('base64url');
    const run = spawnSync(process.execPath, ARGS, { env: environment(creds, presented), input: '', encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown_authority');
    for (const secret of [presented, creds.primary, creds.friend]) expect(run.stderr).not.toContain(secret);
  }, 30_000);
});
