#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { version } = require('./package.json');

const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (process.platform !== 'linux' || !arch) {
  process.stderr.write('Outpost supports Linux x64 and arm64 only\n');
  process.exit(1);
}
const binary = join(__dirname, 'bin', `outpost-${version}-linux-${arch}`);
const args = process.argv.slice(2);
if (args[0] === 'service-install' || args[0] === 'service-upgrade') {
  if (args.some(arg => /^--(?:binary|version)(?:=|$)/.test(arg))) {
    process.stderr.write('The npm package selects its bundled release; omit --binary and --version\n');
    process.exit(1);
  }
  args.push('--binary', binary, '--version', version);
}
const child = spawn(binary, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  process.stderr.write('Cannot start the bundled Outpost binary; reinstall the explicitly selected package version\n');
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exitCode = code;
});
