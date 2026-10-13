import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { versions } from '../plugin/versions.ts';

const directory = mkdtempSync(join(tmpdir(), 'outpost-distribution-'));
const artifact = resolve(`dist/releases/yelqo-paperclip-outpost-${versions.daemon}.tgz`);
const tools = join(directory, 'tools');
const cache = join(directory, 'cache');
const prefix = join(directory, 'global');
const run = (command, args) => execFileSync(command, args, {
  cwd: directory, encoding: 'utf8', timeout: 30000,
  env: {...process.env, PATH: tools, npm_config_cache: cache, npm_config_registry: 'http://127.0.0.1:1', npm_config_offline: 'true'},
  stdio: ['pipe', 'pipe', 'pipe'],
});

before(() => {
  execFileSync(process.execPath, ['scripts/build-release.mjs'], {stdio: 'pipe', timeout: 90000});
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, 'node'));
  const npmBin = dirname(realpathSync(join(dirname(process.execPath), 'npx')));
  for (const name of ['npm', 'npx']) {
    symlinkSync(join(npmBin, `${name}-cli.js`), join(tools, name));
  }
  symlinkSync('/bin/sh', join(tools, 'sh'));
});
after(() => rmSync(directory, {recursive: true, force: true}));

test('pinned global npm and npx artifacts report the selected precompiled release offline without Go', () => {
  assert.ok(existsSync(artifact), 'Release must include the management npm tarball');
  run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', artifact]);
  assert.deepEqual(JSON.parse(run(join(prefix, 'bin/outpost'), ['version'])), versions);
  assert.deepEqual(JSON.parse(run('npx', ['--yes', '--ignore-scripts', `--package=${artifact}`, 'outpost', 'version'])), versions);
  const installed = join(prefix, 'lib/node_modules/@yelqo/paperclip-outpost');
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.version, versions.plugin);
  assert.ok(existsSync(join(installed, pkg.paperclipPlugin.worker)));
  assert.ok(existsSync(join(installed, pkg.paperclipPlugin.manifest)));
  for (const arch of ['amd64', 'arm64']) {
    const name = `outpost-${versions.daemon}-linux-${arch}`;
    assert.deepEqual(readFileSync(join(installed, 'bin', name)), readFileSync(resolve('dist/releases', name)));
  }
  assert.deepEqual(JSON.parse(readFileSync(join(installed, 'COMPATIBILITY.json'), 'utf8')),
    JSON.parse(readFileSync(resolve('release/compatibility.json'), 'utf8')));
  assert.throws(() => run(join(prefix, 'bin/outpost'), ['service-install', '--version=9.8.7']),
    error => /package selects its bundled release/.test(error.stderr));
});
