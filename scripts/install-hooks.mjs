import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const root = git('rev-parse', '--show-toplevel');
const current = git('config', '--get', '--default', '', 'core.hooksPath');
if (current && current !== '.githooks') {
  throw new Error('Refusing to replace an existing hooks configuration.');
}
if (!(statSync(resolve(root, '.githooks/pre-push')).mode & 0o111)) {
  throw new Error('Tracked pre-push hook must be executable.');
}
git('config', '--local', 'core.hooksPath', '.githooks');
console.log('Installed bootstrap main-push guard; full publication gates are not yet implemented.');
