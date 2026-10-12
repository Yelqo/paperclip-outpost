import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const version=JSON.parse(readFileSync('package.json','utf8')).version;
execFileSync(process.execPath,['scripts/generate-versions.mjs','--check'],{stdio:'inherit'});
const destination=resolve('dist/releases');
mkdirSync(destination,{recursive:true});
const checksums=[];
for(const arch of ['amd64','arm64']) {
  const name=`outpost-${version}-linux-${arch}`;
  const path=join(destination,name);
  execFileSync('go',['build','-trimpath','-o',path,'./cmd/outpost'],{
    env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:arch},stdio:'inherit',
  });
  checksums.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${name}`);
}
writeFileSync(join(destination,'SHA256SUMS'),checksums.join('\n')+'\n');
