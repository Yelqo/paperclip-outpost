import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { versions as supportedVersions } from '../plugin/versions.ts';

const root = resolve('.');
const host = join(root, '.cache/paperclip');
const home = mkdtempSync(join(tmpdir(), 'outpost-workflow-'));
const port = 32187;
const origin = `http://127.0.0.1:${port}`;
let server, cookie, company, boardToken;
let logs = '';
const processes = [];
let registered, privateDir, assignedAgent;
let secondPrivate, secondRegistered;
const proxySecrets = { 'CF-Access-Client-Id':'fixture-access-client-id', 'CF-Access-Client-Secret':'fixture-access-client-secret' };

async function api(path, body, auth = cookie, method = body === undefined ? 'GET' : 'POST') {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (auth?.startsWith('Bearer ')) headers.Authorization = auth;
  else if (auth) headers.Cookie = auth;
  return fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(path, body, auth, method) {
  const response = await api(path, body, auth, method);
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function eventually(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  assert.fail('Timed out waiting for public workflow outcome');
}
function cli(args, input) {
  return execFileSync(join(root, 'bin/outpost'), args, {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(host, 'server'), env: {
      ...process.env, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: 'acceptance',
      PORT: String(port), HOST: '127.0.0.1', PAPERCLIP_DEPLOYMENT_MODE: 'authenticated',
      PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private', PAPERCLIP_AUTH_PUBLIC_BASE_URL: origin,
      BETTER_AUTH_SECRET: 'isolated-fixture-secret-with-at-least-32-characters',
      SERVE_UI: 'false', HEARTBEAT_SCHEDULER_ENABLED: 'false',
      PAPERCLIP_DB_BACKUP_ENABLED: 'false', PAPERCLIP_MIGRATION_AUTO_APPLY: 'true',
      PAPERCLIP_MIGRATION_PROMPT: 'never', PAPERCLIP_TELEMETRY_DISABLED: '1',
      PAPERCLIP_ANNOUNCEMENTS_ENABLED: 'false', NODE_ENV: 'production',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  await eventually(async () => {
    if (server.exitCode !== null) throw new Error(`Host exited: ${logs.slice(-5000)}`);
    try { return (await fetch(origin + '/api/health')).ok; } catch { return false; }
  }, 90000);
  const signup = await api('/api/auth/sign-up/email', {name:'Operator', email:'operator@outpost.test', password:'fixture-password-123'});
  assert.ok(signup.ok, await signup.text());
  cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const config = join(home, 'bootstrap.json');
  const dbDir = join(home, 'instances/acceptance/db');
  assert.ok(existsSync(join(dbDir, 'postmaster.pid')), `Cannot find fixture DB: ${home}`);
  writeFileSync(config, JSON.stringify({database:{mode:'embedded-postgres', embeddedPostgresDataDir:dbDir}}));
  const invite = execFileSync(process.execPath, ['--import', join(host, 'server/node_modules/tsx/dist/loader.mjs'), 'packages/db/scripts/create-auth-bootstrap-invite.ts', '--config', config, '--base-url', origin], {
    cwd:host, encoding:'utf8', env:{...process.env, PAPERCLIP_HOME:home}, timeout:15000,
  }).trim().split('/').at(-1);
  await json(`/api/invites/${invite}/accept`, {requestType:'human'});
  company = await json('/api/companies', {name:'Outpost acceptance'});
  const key = await json('/api/board-api-keys', {name:'Outpost fixture operator', requestedCompanyId:company.id});
  boardToken = key.token;
  const installed = await json('/api/plugins/install', {packageName:root, isLocalPath:true});
  assert.ok(installed);
}, {timeout:120000});

after(async () => {
  for (const child of processes) child.kill('SIGTERM');
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(r => server.once('exit', r)), delay(10000)]); }
  writeFileSync(join(home, 'host.log'), logs);
});

test('operator registers a distinct outpost and selects its named environment', async () => {
  privateDir = join(home, 'private');
  const workspace = join(home, 'workspaces');
  const scratch = join(home, 'scratch');
  mkdirSync(workspace); mkdirSync(scratch);
  const output = cli(['register', '--instance', origin, '--company', company.id, '--name', 'Ubuntu worker',
    '--private-dir', privateDir, '--workspace-root', workspace, '--scratch-root', scratch], {operatorAuthorization:`Bearer ${boardToken}`});
  registered = JSON.parse(output);
  assert.equal(registered.name, 'Ubuntu worker');
  const environments = await json(`/api/companies/${company.id}/environments`);
  assert.ok(environments.some(e => e.id === registered.environmentId && e.name === 'Ubuntu worker'));
  const agent = await json(`/api/companies/${company.id}/agents`, {name:'Assigned agent', role:'engineer', adapterType:'pi_local', defaultEnvironmentId:registered.environmentId});
  assignedAgent = agent.id;
  assert.equal(agent.defaultEnvironmentId, registered.environmentId);
  const state = readFileSync(join(privateDir, 'connection.json'), 'utf8');
  assert.ok(!state.includes(boardToken));
  assert.ok(!output.includes(JSON.parse(state).credential));
});

test('the Go daemon connects outbound and the operator observes its authenticated identity', async () => {
  const daemon = spawn(join(root, 'bin/outpost'), ['daemon','--private-dir',privateDir], {stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  let output = ''; daemon.stdout.on('data',data => { output += data; }); daemon.stderr.on('data',data => { output += data; });
  await eventually(async () => {
    assert.equal(daemon.exitCode, null, output);
    const status = await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`);
    return status.connected === true;
  });
  assert.ok(output.includes('connected'));
  daemon.kill('SIGTERM');
  await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
});

test('execution runs a bounded command through the selected outpost and preserves its workspace', async () => {
  const workspace = join(home, 'workspaces', 'existing');
  mkdirSync(workspace);
  execFileSync('git', ['init', workspace], {stdio:'ignore'});
  execFileSync('git', ['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@outpost.test','commit','--allow-empty','-m','Machine history'], {stdio:'ignore'});
  const history = execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'});
  const daemon = spawn(join(root,'bin/outpost'),['daemon','--private-dir',privateDir],{stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  await eventually(async () => (await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
  try {
    const agent = await json(`/api/companies/${company.id}/agents`, {
      name:'Bounded execution', role:'engineer', adapterType:'process', defaultEnvironmentId:registered.environmentId,
      adapterConfig:{command:'/bin/sh',args:['-c','echo launched >> launches; echo machine-output; echo machine-error >&2'],cwd:workspace,timeoutSec:5},
    });
    for (let attempt=0;attempt<2;attempt++) {
      const run = await json(`/api/agents/${agent.id}/heartbeat/invoke`,{});
      let outcome;
      await eventually(async () => {
        outcome = await json(`/api/heartbeat-runs/${run.id}`);
        return !['queued','running'].includes(outcome.status);
      });
      assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
      assert.equal(outcome.exitCode,0);
      const log = await json(`/api/heartbeat-runs/${run.id}/log`);
      assert.match(log.content,/machine-output/);
      assert.match(log.content,/machine-error/);
    }
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launched\nlaunched\n');
    assert.equal(execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}),history);
  } finally {
    daemon.kill('SIGTERM');
    await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
  }
});

async function startExecutionDaemon() {
  const daemon=spawn(join(root,'bin/outpost'),['daemon','--private-dir',privateDir],{stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  let output=''; daemon.stdout.on('data',data => {output+=data;}); daemon.stderr.on('data',data => {output+=data;});
  await eventually(async () => {
    assert.equal(daemon.exitCode,null,output);
    return (await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected;
  });
  return daemon;
}
async function stopExecutionDaemon(daemon) {
  daemon.kill('SIGTERM');
  await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
}
async function commandAgent(cwd,args,extra={}) {
  return json(`/api/companies/${company.id}/agents`,{
    name:'Execution fixture',role:'engineer',adapterType:'process',defaultEnvironmentId:registered.environmentId,
    adapterConfig:{command:'/bin/sh',args:['-c',args],cwd,timeoutSec:5,...extra},
  });
}
async function terminalRun(run) {
  let outcome;
  await eventually(async () => {
    outcome=await json(`/api/heartbeat-runs/${run.id}`);
    return !['queued','running'].includes(outcome.status);
  });
  return outcome;
}

test('execution rejects a missing workspace without creating it',async () => {
  const daemon=await startExecutionDaemon();
  const missing=join(home,'workspaces','missing');
  try {
    const agent=await commandAgent(missing,'echo should-never-launch');
    const outcome=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(outcome.status,'failed');
    assert.match(outcome.error,/existing absolute directory/);
    assert.equal(existsSync(missing),false);
  } finally { await stopExecutionDaemon(daemon); }
});

async function installExecutionAdapter() {
  const fixture=join(home,'execution-adapter');
  mkdirSync(fixture,{recursive:true});
  writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'@yelqo/acceptance-execution-adapter',version:'1.0.0',type:'module',main:'index.mjs'}));
  copyFileSync(join(root,'tests/fixtures/execution-adapter.mjs'),join(fixture,'index.mjs'));
  await json('/api/adapters/install',{packageName:fixture,isLocalPath:true});
  await json('/api/adapters/process/override',{paused:false},cookie,'PATCH');
}
async function removeExecutionAdapter() {
  // The pinned host retains process overrides on uninstall; pause it through
  // the public API first so following tests use the built-in process adapter.
  await json('/api/adapters/process/override',{paused:true},cookie,'PATCH');
  const response=await api('/api/adapters/process',undefined,cookie,'DELETE');
  assert.ok(response.ok,await response.text());
}

test('execution rejects a consumed operation after daemon restart without repeating its effect',async () => {
  await installExecutionAdapter();
  let daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','replay');
  mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'',{scenario:'replay'});
    const first=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(first.status,'succeeded',JSON.stringify(first));
    await stopExecutionDaemon(daemon);
    daemon=await startExecutionDaemon();
    const second=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(second.status,'failed',JSON.stringify(second));
    assert.match(second.error,/already admitted/);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'effect\n');
  } finally { await stopExecutionDaemon(daemon); await removeExecutionAdapter(); }
});

test('execution owns an actual workspace while associated controls and another workspace stay available',async () => {
  await installExecutionAdapter();
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','owned');
  const alias=join(home,'workspaces','owned-alias');
  const separate=join(home,'workspaces','separate');
  mkdirSync(workspace); mkdirSync(separate); symlinkSync(workspace,alias);
  try {
    const owner=await commandAgent(workspace,'',{scenario:'ownership'});
    const competing=await commandAgent(alias,'echo competing >> launches');
    const parallel=await commandAgent(separate,'echo separate > effect');
    const run=await json(`/api/agents/${owner.id}/heartbeat/invoke`,{});
    await eventually(async () => {
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      if(response.status===404) return false;
      assert.ok(response.ok);
      const log=await response.json();
      return log.content?.includes('holding-workspace');
    });
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running','stdout must stream before exit');
    const conflictRun=await json(`/api/agents/${competing.id}/heartbeat/invoke`,{});
    const parallelRun=await json(`/api/agents/${parallel.id}/heartbeat/invoke`,{});
    const conflict=await terminalRun(conflictRun);
    assert.equal(conflict.status,'failed',JSON.stringify(conflict));
    assert.match(conflict.error,/busy/);
    assert.equal((await terminalRun(parallelRun)).status,'succeeded');
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.controlSucceeded,true);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'agent\n');
    assert.equal(readFileSync(join(workspace,'control'),'utf8'),'control\n');
    assert.equal(readFileSync(join(separate,'effect'),'utf8'),'separate\n');
  } finally { await stopExecutionDaemon(daemon); await removeExecutionAdapter(); }
});

test('execution enforces the original deadline and stops descendants before releasing the workspace',async () => {
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','deadline');
  mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch > launches; sleep 3; echo late > late',{timeoutSec:1});
    const outcome=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(outcome.status,'timed_out',JSON.stringify(outcome));
    await delay(3100);
    assert.equal(existsSync(join(workspace,'late')),false);
    const next=await commandAgent(workspace,'echo next > next');
    assert.equal((await terminalRun(await json(`/api/agents/${next.id}/heartbeat/invoke`,{}))).status,'succeeded');
  } finally { await stopExecutionDaemon(daemon); }
});

test('execution stops at its output limit and retains the workspace',async () => {
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','output-limit');
  mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch > launches; yes output');
    const outcome=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(outcome.status,'failed',JSON.stringify(outcome));
    assert.match(outcome.error,/output limit/);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
  } finally { await stopExecutionDaemon(daemon); }
});

test('execution refuses to launch when durable intent cannot be written',async () => {
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','intent-failure');
  mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo forbidden > effect');
    chmodSync(privateDir,0o500);
    const outcome=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{}));
    assert.equal(outcome.status,'failed',JSON.stringify(outcome));
    assert.match(outcome.error,/persist launch intent/);
    assert.equal(existsSync(join(workspace,'effect')),false);
  } finally { chmodSync(privateDir,0o700); await stopExecutionDaemon(daemon); }
});

test('execution keeps a crashed operation consumed and its conflicting workspace blocked',async () => {
  let daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','uncertain');
  mkdirSync(workspace);
  try {
    const first=await commandAgent(workspace,'echo effect >> launches; echo before-crash; sleep 30');
    const run=await json(`/api/agents/${first.id}/heartbeat/invoke`,{});
    await eventually(async () => {
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      return response.ok && (await response.json()).content.includes('before-crash');
    });
    daemon.kill('SIGKILL');
    await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
    await terminalRun(run);
    daemon=await startExecutionDaemon();
    const second=await commandAgent(workspace,'echo duplicate >> launches');
    const outcome=await terminalRun(await json(`/api/agents/${second.id}/heartbeat/invoke`,{}));
    assert.equal(outcome.status,'failed',JSON.stringify(outcome));
    assert.match(outcome.error,/uncertain/);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'effect\n');
  } finally { await stopExecutionDaemon(daemon); }
});

test('execution uses the task project workspace and exposes its run through public task state',async () => {
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','project-task');
  mkdirSync(workspace);
  try {
    const project=await json(`/api/companies/${company.id}/projects`,{name:'Machine-owned project'});
    const projectWorkspace=await json(`/api/projects/${project.id}/workspaces`,{name:'Existing outpost checkout',cwd:workspace});
    const agent=await commandAgent(join(home,'workspaces','unused-agent-default'),'echo task-effect > effect; echo task-output');
    const task=await json(`/api/companies/${company.id}/issues`,{
      title:'Bounded outpost task',status:'backlog',projectId:project.id,projectWorkspaceId:projectWorkspace.id,assigneeAgentId:agent.id,
    });
    const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{payload:{issueId:task.id}});
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
    assert.equal(outcome.contextSnapshot.issueId,task.id);
    const observed=await json(`/api/issues/${task.id}`);
    assert.equal(observed.projectWorkspaceId,projectWorkspace.id);
    assert.equal(readFileSync(join(workspace,'effect'),'utf8'),'task-effect\n');
    assert.equal(existsSync(join(home,'workspaces','unused-agent-default')),false);
  } finally { await stopExecutionDaemon(daemon); }
});

const connection = () => JSON.parse(readFileSync(join(privateDir,'connection.json'),'utf8'));
function transport(c = connection(), versionOverrides = {}, route = 'transport', extraHeaders = {}) {
  const versions = {...supportedVersions,...versionOverrides};
  return new WebSocket(`${origin.replace('http','ws')}/api/plugins/yelqo.outpost/ws/${route}?companyId=${c.companyId}&outpostId=${c.outpostId}`, {
    headers:{Authorization:`Bearer ${c.credential}`,'X-Outpost-Versions':JSON.stringify(versions),...extraHeaders},
  });
}
async function rejected(ws, timeout = 10000) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => {ws.terminate(); reject(new Error('Transport rejection timed out'));},timeout);
    ws.on('open',() => {clearTimeout(timer); ws.terminate(); reject(new Error('Unauthorized transport accepted'));});
    ws.on('unexpected-response',(_req,res) => {clearTimeout(timer); res.resume(); ws.terminate(); resolve(res.statusCode);});
    ws.on('error',() => {});
  });
}
async function ready(ws) {
  return new Promise((resolve,reject) => {
    ws.once('message',data => resolve(JSON.parse(data.toString())));
    ws.once('error',reject);
  });
}

test('machine credentials authorize only their registered company transport', async () => {
  const c = connection();
  const other = await json('/api/companies',{name:'Other company'});
  assert.equal(await rejected(transport({...c,companyId:other.id})),401);
  assert.equal(await rejected(transport({...c,credential:boardToken})),401);
  assert.equal(await rejected(transport({...c,credential:'invalid-outpost-secret'})),401);
  assert.equal(await rejected(transport(c,{},'undeclared')),404);
  for (const [path,body,method] of [
    ['/api/companies', {name:'Unauthorized board action'},'POST'],
    ['/api/agents/me',undefined,'GET'],
    ['/api/plugins/yelqo.outpost/api/outposts',{companyId:company.id,name:'Unauthorized registration'},'POST'],
  ]) {
    const response = await api(path,body,`Bearer ${c.credential}`,method);
    assert.ok([401,403].includes(response.status),`${path} accepted machine authentication: ${response.status}`);
  }
  const status = await api(`/api/plugins/yelqo.outpost/api/outposts/${c.outpostId}?companyId=${other.id}`);
  assert.equal(status.status,404);
  const agentKey = await json(`/api/agents/${assignedAgent}/keys`,{name:'Work agent fixture'});
  assert.equal((await api('/api/plugins/yelqo.outpost/api/outposts',{companyId:company.id,name:'Agent registration'},`Bearer ${agentKey.token}`)).status,403);
  assert.equal(await rejected(transport({...c,credential:agentKey.token})),401);
});

test('every supported version pin is checked before the transport accepts work', async () => {
  for (const field of ['host','sdk','plugin','daemon','protocol']) {
    assert.equal(await rejected(transport(connection(),{[field]:field==='protocol'?supportedVersions.protocol+1:'incompatible'})),426,field);
  }
});

test('core bounds frames and closes the connection without leaving plugin-owned state', async () => {
  const ws = transport();
  assert.equal((await ready(ws)).outpostId,registered.outpostId);
  const closed = new Promise(resolve => ws.once('close',resolve));
  ws.on('error',() => {});
  ws.send('x'.repeat(16385));
  assert.equal(await closed,1009);
  await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
  assert.match(cli(['connect','--private-dir',privateDir]),/connected/);
});

test('revocation rejects subsequent connections from the actual Go daemon', async () => {
  assert.equal((await api(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}/revoke`,{companyId:company.id})).status,204);
  assert.throws(() => cli(['connect','--private-dir',privateDir]),error => {
    assert.match(error.stderr,/outpost connection rejected/);
    assert.ok(!error.stderr.includes(connection().credential));
    return true;
  });
  assert.equal(await rejected(transport()),403);
});

test('same-UID runtime isolation hides connection files and the daemon process namespace', () => {
  const privateFile = join(privateDir,'connection.json');
  // Ordinary same-UID permissions do allow a read: the launcher must add isolation.
  assert.ok(readFileSync(privateFile,'utf8').includes(connection().credential));
  const output = cli(['protect','--private-dir',privateDir,'--','/bin/sh','-c',
    `test ! -e '${privateFile}' && test ! -e /proc/${process.pid}/environ && echo isolated`]);
  assert.match(output,/isolated/);
});

test('an agent from another company cannot select the outpost environment', async () => {
  const other = await json('/api/companies',{name:'Company placement rejection'});
  const response = await api(`/api/companies/${other.id}/agents`,{name:'Wrong company agent',role:'engineer',adapterType:'pi_local',defaultEnvironmentId:registered.environmentId});
  assert.equal(response.status,422);
});

test('a company-scoped outpost cannot become the instance-wide default', async () => {
  const response = await api('/api/instance/settings', {defaultEnvironmentId:registered.environmentId}, cookie, 'PATCH');
  assert.equal(response.status,422);
});

test('private state cannot sit beneath any agent-writable root, including filesystem root', () => {
  assert.throws(() => cli(['register','--instance',origin,'--company',company.id,'--name','Unsafe placement',
    '--private-dir',join(home,'unsafe-private'),'--workspace-root','/','--scratch-root',join(home,'scratch')],
    {operatorAuthorization:`Bearer ${boardToken}`}),error => { assert.match(error.stderr,/outside workspace and scratch roots/); return true; });
  const file = join(privateDir,'connection.json');
  chmodSync(file,0o644);
  try { assert.throws(() => cli(['diagnose','--private-dir',privateDir]),/mode 0600/); }
  finally { chmodSync(file,0o600); }
});

test('optional access headers are shared by registration and daemon without appearing in diagnostics or logs', () => {
  secondPrivate = join(home,'second-private');
  secondRegistered = JSON.parse(cli(['register','--instance',origin,'--company',company.id,'--name','Access worker',
    '--private-dir',secondPrivate,'--workspace-root',join(home,'workspaces'),'--scratch-root',join(home,'scratch')],
    {operatorAuthorization:`Bearer ${boardToken}`,headers:proxySecrets}));
  const connected = cli(['connect','--private-dir',secondPrivate]);
  const diagnostic = cli(['diagnose','--private-dir',secondPrivate]);
  const c = JSON.parse(readFileSync(join(secondPrivate,'connection.json'),'utf8'));
  for (const secret of [boardToken, connection().credential,c.credential,...Object.values(proxySecrets)]) {
    assert.ok(!logs.includes(secret),'Credential present in host logs');
    assert.ok(!diagnostic.includes(secret),'Credential present in diagnostic output');
    assert.ok(!connected.includes(secret),'Credential present in connection output');
  }
});

test('duplicate connections and machine-authored company changes are rejected, then scoped cleanup permits reconnect', async () => {
  const c = JSON.parse(readFileSync(join(secondPrivate,'connection.json'),'utf8'));
  const ws = transport(c);
  await ready(ws);
  assert.equal(await rejected(transport(c)),409);
  const closed = new Promise(resolve => ws.once('close',resolve));
  ws.send(JSON.stringify({type:'heartbeat',companyId:'another-company'}));
  assert.equal(await closed,1008);
  await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${c.outpostId}?companyId=${company.id}`)).connected);
  assert.match(cli(['connect','--private-dir',secondPrivate]),/connected/);
});

test('the actual Go daemon retries a transient persistence failure instead of exiting', async () => {
  const { default: postgres } = await import(join(host,'packages/db/node_modules/postgres/src/index.js'));
  const daemon = spawn(join(root,'bin/outpost'),['daemon','--private-dir',secondPrivate],{stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  let output = ''; daemon.stdout.on('data',data => {output += data;}); daemon.stderr.on('data',data => {output += data;});
  const statusPath = `/api/plugins/yelqo.outpost/api/outposts/${secondRegistered.outpostId}?companyId=${company.id}`;
  await eventually(async () => (await json(statusPath)).connected);
  // Inject a real persistence outage in the disposable DB. All observations
  // remain at the public daemon/API seam, rather than reading stored records.
  const dbPort = readFileSync(join(home,'instances/acceptance/db/postmaster.pid'),'utf8').split('\n')[3];
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${dbPort}/paperclip`,{max:1});
  try {
    await sql`ALTER TABLE plugin_state RENAME TO unavailable_plugin_state`;
    try {
      await eventually(async () => {assert.equal(daemon.exitCode,null,output); return output.includes('disconnected');});
    } finally { await sql`ALTER TABLE unavailable_plugin_state RENAME TO plugin_state`; }
    await eventually(async () => (await json(statusPath)).connected);
  } finally { await sql.end(); daemon.kill('SIGTERM'); }
  await eventually(async () => !(await json(statusPath)).connected);
});

test('disconnected clients cannot bypass the bound on pending admission work', async () => {
  const { default: postgres } = await import(join(host,'packages/db/node_modules/postgres/src/index.js'));
  const dbPort = readFileSync(join(home,'instances/acceptance/db/postmaster.pid'),'utf8').split('\n')[3];
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${dbPort}/paperclip`,{max:1});
  const c = JSON.parse(readFileSync(join(secondPrivate,'connection.json'),'utf8'));
  try {
    await sql.begin(async transaction => {
      await transaction`LOCK TABLE plugins IN ACCESS EXCLUSIVE MODE`;
      for (let i=0;i<64;i++) {
        const ws = transport(c);
        ws.on('error',() => {});
        await delay(25);
        ws.terminate();
      }
      // Let the raw socket deadlines expire while registry lookups stay blocked.
      await delay(6500);
      assert.equal(await rejected(transport(c),1000),503);
    });
  } finally { await sql.end(); }
  await eventually(async () => {
    try { return cli(['connect','--private-dir',secondPrivate]).includes('connected'); }
    catch { return false; }
  });
});

test('the actual Go daemon reconnects after plugin restart while revocation remains durable', async () => {
  const daemon = spawn(join(root,'bin/outpost'),['daemon','--private-dir',secondPrivate],{stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  let output = ''; daemon.stdout.on('data',data => {output += data;}); daemon.stderr.on('data',data => {output += data;});
  const statusPath = `/api/plugins/yelqo.outpost/api/outposts/${secondRegistered.outpostId}?companyId=${company.id}`;
  await eventually(async () => (await json(statusPath)).connected);
  await json('/api/plugins/yelqo.outpost/disable',{});
  await eventually(async () => output.includes('disconnected'),20000);
  assert.equal(daemon.exitCode,null,output);
  await json('/api/plugins/yelqo.outpost/enable',{});
  await eventually(async () => (await json(statusPath)).connected,20000);
  assert.equal(await rejected(transport()),403);
  daemon.kill('SIGTERM');
  await eventually(async () => !(await json(statusPath)).connected);
});

test('the actual host rejects WebSocket declarations without the required capability', async () => {
  const fixture = join(home,'undeclared-plugin');
  mkdirSync(join(fixture,'dist'),{recursive:true});
  writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'@yelqo/undeclared-outpost',version:supportedVersions.plugin,type:'module',paperclipPlugin:{manifest:'./dist/manifest.js',worker:'./dist/worker.js'}}));
  const manifest = readFileSync(join(root,'dist/manifest.js'),'utf8').replace('yelqo.outpost','yelqo.undeclared-outpost').replace('"transport.websockets.register",','');
  writeFileSync(join(fixture,'dist/manifest.js'),manifest);
  writeFileSync(join(fixture,'dist/worker.js'),readFileSync(join(root,'dist/worker.js')));
  assert.equal((await api('/api/plugins/install',{packageName:fixture,isLocalPath:true})).status,400);
});
