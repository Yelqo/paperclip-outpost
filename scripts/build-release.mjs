import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const pkg=JSON.parse(readFileSync('package.json','utf8'));
const version=pkg.version;
execFileSync(process.execPath,['scripts/generate-versions.mjs','--check'],{stdio:'inherit'});
execFileSync(process.execPath,['scripts/build-plugin.mjs'],{stdio:'inherit'});
const destination=resolve('dist/releases');
rmSync(destination,{recursive:true,force:true});
mkdirSync(destination,{recursive:true});
const checksums=[];
const recordChecksum = name => checksums.push(`${createHash('sha256').update(readFileSync(join(destination,name))).digest('hex')}  ${name}`);
for(const arch of ['amd64','arm64']) {
  const name=`outpost-${version}-linux-${arch}`;
  const path=join(destination,name);
  execFileSync('go',['build','-trimpath','-o',path,'./cmd/outpost'],{
    env:{...process.env,CGO_ENABLED:'0',GOOS:'linux',GOARCH:arch},stdio:'inherit',
  });
  recordChecksum(name);
}
// One release package supplies the bundled plugin and the management command.
// It has no install hooks or dependencies on the development host checkout.
const staging=mkdtempSync(join(tmpdir(),'outpost-npm-'));
try {
  mkdirSync(join(staging,'bin'));
  for(const arch of ['amd64','arm64']) {
    const name=`outpost-${version}-linux-${arch}`;
    copyFileSync(join(destination,name),join(staging,'bin',name));
    chmodSync(join(staging,'bin',name),0o755);
  }
  copyFileSync('npm/outpost.cjs',join(staging,'outpost.cjs'));
  chmodSync(join(staging,'outpost.cjs'),0o755);
  copyFileSync('LICENSE',join(staging,'LICENSE'));
  copyFileSync('docs/releases.md',join(staging,'README.md'));
  copyFileSync('release/compatibility.json',join(staging,'COMPATIBILITY.json'));
  mkdirSync(join(staging,'dist'));
  for(const name of ['worker.js','manifest.js','worker.js.map','manifest.js.map']) {
    copyFileSync(join('dist',name),join(staging,'dist',name));
  }
  writeFileSync(join(staging,'package.json'),JSON.stringify({
    name:pkg.name,version,type:pkg.type,description:'Paperclip Outpost plugin, management command and precompiled daemon',
    license:'MIT',repository:{type:'git',url:'https://github.com/Yelqo/paperclip-outpost.git'},
    paperclipPlugin:pkg.paperclipPlugin,
    bin:{outpost:'outpost.cjs'},os:['linux'],cpu:['x64','arm64'],engines:pkg.engines,
    files:['outpost.cjs','bin','dist','COMPATIBILITY.json'],publishConfig:{access:'public'},
  },null,2)+'\n');
  const [packed]=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',destination],{cwd:staging,encoding:'utf8'}));
  recordChecksum(packed.filename);
} finally { rmSync(staging,{recursive:true,force:true}); }
copyFileSync('release/compatibility.json',join(destination,'COMPATIBILITY.json'));
recordChecksum('COMPATIBILITY.json');
writeFileSync(join(destination,'SHA256SUMS'),checksums.join('\n')+'\n');
