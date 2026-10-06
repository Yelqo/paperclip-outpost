import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname,'..');
const host = resolve(root,'.cache/paperclip');
const lock = JSON.parse(readFileSync(resolve(root,'upstream/paperclip.lock.json'),'utf8'));
const patch = resolve(root,'upstream',lock.patch);
function run(command,args,cwd=host) {
  execFileSync(command,args,{cwd,stdio:'inherit'});
}
mkdirSync(resolve(root,'.cache'),{recursive:true});
if (!existsSync(resolve(host,'.git'))) {
  run('git',['clone','--no-checkout','--depth','1',lock.repository,host],root);
  run('git',['fetch','--depth','1','origin',lock.commit]);
  run('git',['checkout','--detach',lock.commit]);
}
const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:host,encoding:'utf8'}).trim();
if (commit !== lock.commit) throw new Error('Cached Paperclip checkout does not match the pin; preserve it and use a fresh .cache/paperclip directory.');
if (spawnSync('git',['apply','--reverse','--check',patch],{cwd:host,stdio:'ignore'}).status !== 0) {
  run('git',['apply','--check',patch]);
  run('git',['apply',patch]);
}
run('pnpm',['install','--frozen-lockfile','--filter','@paperclipai/server...','--filter','@paperclipai/plugin-sdk...']);
run('pnpm',['--filter','@paperclipai/plugin-sdk','build']);
// Registration/connection do not use the Rust runner. Build the TS imports
// used by the real server without provisioning an unrelated execution engine.
run('pnpm',['--filter','@paperclipai/paperclip-runner','build:typescript']);
