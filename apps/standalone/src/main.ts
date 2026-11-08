/**
 * The standalone process entry: `npm run standalone -- <command> --config <file>` (tsx runs the TypeScript sources).
 * It binds the CLI to this process's streams, environment and Ctrl-C.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  readFile: (path) => readFile(path, 'utf8'),
  lines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
  onInterrupt: (handler) => {
    process.on('SIGINT', handler);
    return () => process.off('SIGINT', handler);
  },
});
