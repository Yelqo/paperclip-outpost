import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root=resolve(import.meta.dirname,'..');
const runtime=resolve(root,'.cache/pi-config');
const host=resolve(root,'.cache/paperclip');
const lock=JSON.parse(readFileSync(resolve(root,'upstream/pi-config.lock.json'),'utf8'));
const patch=resolve(root,'upstream',lock.patch);
const run=(command,args,cwd=runtime)=>execFileSync(command,args,{cwd,stdio:'inherit'});
mkdirSync(resolve(root,'.cache'),{recursive:true});
if(!existsSync(resolve(runtime,'.git'))) {
  // pi-config is private. A scoped CI read token remains in the child
  // environment, never in a command argument, remote URL or generated file.
  const token=process.env.OUTPOST_PI_CONFIG_READ_TOKEN;
  if(token) {
    const temporary=mkdtempSync(join(tmpdir(),'outpost-pi-auth-'));
    try {
      const askpass=join(temporary,'askpass');
      writeFileSync(askpass,'#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "$OUTPOST_PI_CONFIG_READ_TOKEN" ;; esac\n');
      chmodSync(askpass,0o700);
      execFileSync('git',['-c','credential.helper=','clone','--no-checkout',lock.repository,runtime],{
        cwd:root,stdio:'inherit',env:{...process.env,GIT_ASKPASS:askpass,GIT_TERMINAL_PROMPT:'0'},
      });
    } finally { rmSync(temporary,{recursive:true,force:true}); }
  } else {
    run('git',['clone','--no-checkout',lock.repository,runtime],root);
  }
  run('git',['checkout','--detach',lock.commit]);
}
delete process.env.OUTPOST_PI_CONFIG_READ_TOKEN;
if(execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim()!==lock.commit) {
  throw new Error('Cached pi-config does not match its pin; preserve it and prepare a fresh .cache/pi-config.');
}
if(spawnSync('git',['apply','--reverse','--check',patch],{cwd:runtime,stdio:'ignore'}).status!==0) {
  run('git',['apply','--check',patch]);
  run('git',['apply',patch]);
}
run('mise',['install',`node@${lock.node}`,`pnpm@${lock.pnpm}`]);
run('mise',['exec',`node@${lock.node}`,`pnpm@${lock.pnpm}`,'--','pnpm','install','--frozen-lockfile']);
// Install the actual pinned Paperclip gateway as an operator-owned runtime asset.
// Runs consume this asset; the adapter never uploads or replaces it.
mkdirSync(resolve(runtime,'runtime'),{recursive:true});
const source=execFileSync(process.execPath,['--import',resolve(host,'server/node_modules/tsx/dist/loader.mjs'),
  '--input-type=module','-e',`import {getSandboxCallbackBridgeServerSource} from ${JSON.stringify(resolve(host,'packages/adapter-utils/src/sandbox-callback-bridge.ts'))}; process.stdout.write(getSandboxCallbackBridgeServerSource());`],{cwd:root,encoding:'utf8'});
writeFileSync(resolve(runtime,'runtime/callback-bridge.mjs'),source);
run('mise',['exec',`node@${lock.node}`,`pnpm@${lock.pnpm}`,'--','pnpm','check']);
