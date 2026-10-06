import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const cwd = resolve(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '-z', '--', '*.go'], { cwd, encoding: 'utf8' })
  .split('\0').filter(Boolean);
if (files.length === 0) throw new Error('No tracked Go files found to check.');

const unformatted = execFileSync('gofmt', ['-l', ...files], { cwd, encoding: 'utf8' }).trim();
if (unformatted) {
  console.error(`Go files need formatting:\n${unformatted}\nRun gofmt -w on the files above.`);
  process.exitCode = 1;
}
