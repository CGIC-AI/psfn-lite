/**
 * The standalone CLI in its own process with the test host ports (faux
 * model, deterministic embeddings, fixed classifier), for the restart test:
 * the donor runs one companion runtime per process, so a restart is a new
 * process. Every model request whose last user message carries the marker
 * LITE_TEST_MARKER (the operator's turn) is appended, as JSON, to the file
 * named by LITE_TEST_CALLS_FILE and answered with LITE_TEST_REPLY.
 */
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runCli } from '../../../apps/standalone/src/index.ts';
import { fauxModel } from '../../support/faux-model.ts';
import { deterministicEmbeddings } from '../../support/embeddings.ts';

const callsFile = process.env['LITE_TEST_CALLS_FILE'] ?? '';
const marker = process.env['LITE_TEST_MARKER'] ?? '';
const reply = process.env['LITE_TEST_REPLY'] ?? '';
const model = fauxModel((call) => {
  if (marker === '' || !call.lastUser.includes(marker)) return null;
  appendFileSync(callsFile, `${JSON.stringify({ systemPrompt: call.systemPrompt, messages: call.context.messages })}\n`);
  return reply;
});
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    readFile: (path) => readFile(path, 'utf8'),
    lines: async function* () {},
    onInterrupt: () => () => undefined,
  },
  {
    model: model.runtime,
    embeddings: deterministicEmbeddings,
    textEmotionClassifier: { preload: () => Promise.resolve(), classify: () => Promise.resolve([{ label: 'neutral', score: 1 }]) },
  },
);
