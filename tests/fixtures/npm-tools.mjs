import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Provision only the management tools in the disposable offline Linux guest.
// The product release never downloads or provisions Node, npm or a compiler.
export async function npmTools(vm, directory) {
  const archive = join(directory, 'npm-tools.tgz');
  if (!existsSync(archive)) {
    const staging = join(directory, 'npm-tools');
    mkdirSync(join(staging, 'node/bin'), {recursive:true});
    cpSync(process.execPath, join(staging, 'node/bin/node'));
    const npm = join(dirname(realpathSync(join(dirname(process.execPath), 'npx'))), '..');
    cpSync(npm, join(staging, 'node/lib/node_modules/npm'), {recursive:true});
    for (const name of ['npm', 'npx']) symlinkSync(`../lib/node_modules/npm/bin/${name}-cli.js`, join(staging, 'node/bin', name));
    execFileSync('tar', ['-czf', archive, '-C', staging, 'node']);
  }
  await vm.copy(archive, '/srv/npm-tools.tgz');
  await vm.command(['tar', '-xzf', '/srv/npm-tools.tgz', '-C', '/srv']);
  await vm.command(['rm', '/srv/npm-tools.tgz']);
}
