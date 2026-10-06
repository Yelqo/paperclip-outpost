import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('changing release and upstream pins requires regeneration before checks pass', async () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(tmpdir(), 'outpost-versions-'));
  for (const path of ['scripts', 'plugin', 'internal/outpost', 'upstream']) mkdirSync(join(fixture, path), {recursive:true});
  for (const path of ['scripts/generate-versions.mjs', 'package.json', 'upstream/paperclip.lock.json',
    'upstream/plugin-transport.patch', 'plugin/versions.ts', 'internal/outpost/versions.go']) {
    copyFileSync(join(root, path), join(fixture, path));
  }
  const generate = (...args) => execFileSync(process.execPath, [join(fixture, 'scripts/generate-versions.mjs'), ...args], {stdio:'pipe'});
  generate('--check');

  const release = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  release.version = '9.8.7';
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(release));
  const lock = JSON.parse(readFileSync(join(fixture, 'upstream/paperclip.lock.json'), 'utf8'));
  lock.commit = 'a'.repeat(40);
  lock.sdk = '9.0.0+fixture';
  lock.transport++;
  writeFileSync(join(fixture, 'upstream/paperclip.lock.json'), JSON.stringify(lock));
  assert.throws(() => generate('--check'), error => /Stale compatibility declarations/.test(error.stderr.toString()));
  generate();
  generate('--check');

  const {versions} = await import(pathToFileURL(join(fixture, 'plugin/versions.ts')));
  assert.deepEqual(versions, {host:lock.commit, sdk:lock.sdk, plugin:release.version, daemon:release.version, protocol:lock.transport});
});
