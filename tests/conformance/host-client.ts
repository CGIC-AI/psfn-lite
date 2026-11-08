/**
 * The TypeScript runner's handle on a conformance host process: start it
 * over a HostState, send requests, wait for brain events, and kill it to
 * crash the runtime. A killed host's state (the last snapshot it reported)
 * starts the successor.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HostState, Principal } from './host/host.ts';
import type { Vars } from './scenario.ts';

const REPO = join(import.meta.dirname, '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const ENTRY = join(import.meta.dirname, 'fixtures', 'host-process.ts');
const READY_TIMEOUT_MS = 60_000;

export interface HostReady {
  readonly mcpUrl: string;
  readonly lifecycleUrl: string;
  readonly credentials: Readonly<Record<Principal, string>>;
  readonly vars: Vars;
  readonly state: HostState;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class HostProcess {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private waiters: { readonly event: string; readonly resolve: () => void }[] = [];
  private exited = false;
  state: HostState;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly ready: HostReady,
    private readonly log: { readonly stderr: string },
  ) {
    this.state = ready.state;
  }

  /** The host's recent stderr, for failure messages. */
  get stderr(): string {
    return this.log.stderr;
  }

  static async start(state: HostState): Promise<HostProcess> {
    const child = spawn(TSX, [ENTRY], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '' } });
    const log = { stderr: '' };
    child.stderr.on('data', (chunk: Buffer) => {
      log.stderr = `${log.stderr}${chunk.toString()}`.slice(-20_000);
      if (process.env['LITE_CONFORMANCE_DEBUG'] === '1') process.stderr.write(chunk);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let host: HostProcess | null = null;
    const ready = new Promise<HostReady>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the conformance host did not start: ${log.stderr}`)), READY_TIMEOUT_MS);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the conformance host exited (${String(code)}) before it was ready: ${log.stderr}`));
      });
      lines.on('line', (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (host !== null) {
          host.receive(message);
          return;
        }
        if (message['event'] === 'ready') {
          clearTimeout(timer);
          resolve(message as unknown as HostReady);
        }
      });
    });
    child.stdin.write(`${JSON.stringify(state)}\n`);
    const value = await ready;
    const made = new HostProcess(child, value, log);
    host = made;
    child.removeAllListeners('exit');
    child.once('exit', () => made.onExit());
    return made;
  }

  private receive(message: Record<string, unknown>): void {
    if (typeof message['event'] === 'string') {
      const event = message['event'];
      const matched = this.waiters.filter((w) => w.event === event);
      this.waiters = this.waiters.filter((w) => w.event !== event);
      for (const waiter of matched) waiter.resolve();
      return;
    }
    const id = message['id'] as number;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (typeof message['state'] === 'object' && message['state'] !== null) this.state = message['state'] as HostState;
    if (message['ok'] === true) entry.resolve(message['value']);
    else entry.reject(new Error(String(message['error'])));
  }

  private onExit(): void {
    this.exited = true;
    for (const entry of this.pending.values()) entry.reject(new Error(`the conformance host exited: ${this.stderr}`));
    this.pending.clear();
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error('the conformance host has exited'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  /** Resolves on the next event of that name after this call; register it before sending the request that causes it. */
  nextEvent(event: string, timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} event within ${String(timeoutMs)} ms`)), timeoutMs);
      this.waiters.push({
        event,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** SIGKILL: no shutdown path runs; whatever was in flight is lost exactly as in a crash. */
  async kill(): Promise<HostState> {
    if (!this.exited) {
      const gone = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
      this.child.kill('SIGKILL');
      await gone;
    }
    return this.state;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const gone = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    await this.request('close').catch(() => undefined);
    this.child.stdin.end();
    await gone;
  }
}
