import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Build the same daemon implementation with a distinct selected release pin.
// This fixture exercises a real version transition and compatibility rejection.
export function lifecycleRelease(directory, previous, selected) {
  mkdirSync(directory,{recursive:true});
  for(const path of ['go.mod','go.sum','cmd','internal']) cpSync(resolve(path),join(directory,path),{recursive:true});
  const versions=join(directory,'internal/outpost/versions.go');
  writeFileSync(versions,readFileSync(versions,'utf8').replaceAll(`"${previous}"`,`"${selected}"`));
  const binary=join(directory,'outpost');
  execFileSync('go',['build','-trimpath','-o',binary,'./cmd/outpost'],{
    cwd:directory,env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:'amd64'},timeout:90000,stdio:'pipe',
  });
  return binary;
}
