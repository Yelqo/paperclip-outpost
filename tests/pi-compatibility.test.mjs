import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

test('Pi launcher rejects unsupported prepared pi-config before callbacks or agent work', () => {
  const runtime = resolve('.cache/pi-config');
  const manifest = join(runtime, 'runtime/outpost-compatibility.json');
  const saved = existsSync(manifest) ? readFileSync(manifest) : undefined;
  const supported = JSON.parse(readFileSync('release/compatibility.json', 'utf8'));
  const node = join(execFileSync('mise', ['where', `node@${supported.node}`], {encoding:'utf8'}).trim(), 'bin/node');
  mkdirSync(dirname(manifest), {recursive:true});
  try {
    writeFileSync(manifest, JSON.stringify({...supported, piConfig:'unsupported-checkout'}));
    assert.throws(() => execFileSync(join(runtime, 'scripts/paperclip-pi'), ['--version'], {
      encoding:'utf8', timeout:15000,
      env:{...process.env, PATH:`${dirname(node)}:/usr/bin:/bin`},
      stdio:['ignore','pipe','pipe'],
    }), error => {
      assert.match(error.stderr, /Pi runtime is incompatible/);
      assert.equal(error.stdout, '');
      return true;
    });
  } finally {
    if (saved) writeFileSync(manifest, saved);
    else rmSync(manifest, {force:true});
  }
});

test('Pi launcher rejects the management Node version before callbacks or agent work', () => {
  assert.throws(() => execFileSync(resolve('.cache/pi-config/scripts/paperclip-pi'), ['--version'], {
    encoding:'utf8', timeout:15000,
    env:{...process.env, PATH:`${dirname(process.execPath)}:/usr/bin:/bin`},
    stdio:['ignore','pipe','pipe'],
  }), error => {
    assert.match(error.stderr, /Pi runtime is incompatible/);
    assert.equal(error.stdout, '');
    return true;
  });
});
