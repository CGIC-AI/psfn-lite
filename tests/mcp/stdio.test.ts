/**
 * The stdio transport in a real child process, driven by the SDK's stdio
 * client: the process's credential selects its binding, every call reaches
 * the host tool port as that principal, and an unbound credential stops
 * startup without echoing it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOLS } from './fixtures/port.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURE = join(import.meta.dirname, 'fixtures', 'stdio-server.ts');
const ARGS = ['--import', 'tsx', FIXTURE];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function credentials() {
  return { robin: randomBytes(32).toString('base64url'), sam: randomBytes(32).toString('base64url') };
}

function environment(creds: ReturnType<typeof credentials>, presented: string): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', STDIO_ROBIN: creds.robin, STDIO_SAM: creds.sam, LITE_MCP_CREDENTIAL: presented };
}

describe('stdio transport', () => {
  it('serves the host catalog to the bound principal of the process', async () => {
    const creds = credentials();
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ARGS, cwd: ROOT, env: environment(creds, creds.sam), stderr: 'pipe' }));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const called = await client.callTool({ name: 'memory', arguments: { action: 'search', principal: 'robin' } });
    expect(called.structuredContent).toEqual({ origin: 'tool_result', text: 'ran memory for sam' });
  }, 30_000);

  it('refuses to start with an unbound credential and does not echo it', () => {
    const creds = credentials();
    const presented = randomBytes(32).toString('base64url');
    const run = spawnSync(process.execPath, ARGS, { cwd: ROOT, env: environment(creds, presented), input: '', encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unknown_authority');
    for (const secret of [presented, creds.robin, creds.sam]) expect(run.stderr).not.toContain(secret);
  }, 30_000);
});
