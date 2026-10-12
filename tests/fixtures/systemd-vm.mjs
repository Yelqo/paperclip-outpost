import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);

// SSH controls only this disposable acceptance VM. Outpost still connects
// outbound through the actual host/plugin API; SSH is not a product transport.
export async function systemdVM(t, port, version) {
  const name = `outpost-systemd-${process.pid}`;
  t.after(async () => {
    await exec('docker', ['rm', '--force', name]);
  });
  await exec('docker', ['run', '--detach', '--name', name, '--network', 'host',
    '--env', `OUTPOST_TEST_RELEASE=${version}`,
    '--mount', `type=bind,src=${resolve('dist/releases')},dst=/input,readonly`,
    'outpost-systemd-acceptance:local']);
  const command = async (args, input) => {
    const quoted=args.map(value => `'${String(value).replaceAll("'", "'\\''")}'`).join(' ');
    const child = spawn('docker', ['exec', '-i', name, 'vm-exec', quoted], {stdio:['pipe','pipe','pipe'],timeout:90000});
    let stdout='', stderr='';
    child.stdout.on('data', data => {stdout += data;});
    child.stderr.on('data', data => {stderr += data;});
    child.stdin.end(input);
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`VM command failed (${code}): ${stderr}`)));
    });
  };
  const ready = async () => {
    for(let attempt=0; attempt<180; attempt++) {
      try { await command(['true']); return; } catch { await delay(1000); }
    }
    const {stdout,stderr} = await exec('docker',['logs','--tail','80',name]);
    throw new Error(`Ubuntu VM did not boot: ${stdout}${stderr}`);
  };
  const connect = async () => {
    await ready();
    await exec('docker', ['exec', name, 'ssh', '-S', '/tmp/fixture-forward', '-O', 'exit', 'root@127.0.0.1']).catch(() => {});
    await exec('docker', ['exec', name, 'ssh', '-i', '/tmp/fixture-key', '-p', '32222',
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
      '-o', 'ServerAliveInterval=1', '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes', '-f', '-N', '-M', '-S', '/tmp/fixture-forward',
      '-R', `${port}:127.0.0.1:${port}`, 'root@127.0.0.1']);
  };
  await connect();
  return {command, connect};
}
