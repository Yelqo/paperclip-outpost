import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, chmodSync, symlinkSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { createServer as createTCPServer, connect as connectTCP } from 'node:net';
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
function providerResponse(res, delta, finishReason) {
  res.writeHead(200,{'content-type':'text/event-stream'});
  const event=(delta,finish_reason)=>({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
  res.write(`data: ${JSON.stringify(event(delta,null))}\n\n`);
  res.write(`data: ${JSON.stringify(event({},finishReason))}\n\n`);
  res.end('data: [DONE]\n\n');
}

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(host, 'server'), env: {
      ...process.env, PAPERCLIP_HOME: home, PAPERCLIP_INSTANCE_ID: 'acceptance',
      PORT: String(port), HOST: '127.0.0.1', PAPERCLIP_DEPLOYMENT_MODE: 'authenticated',
      PAPERCLIP_DEPLOYMENT_EXPOSURE: 'private', PAPERCLIP_AUTH_PUBLIC_BASE_URL: origin,
      BETTER_AUTH_SECRET: 'isolated-fixture-secret-with-at-least-32-characters',
      SERVE_UI: 'false', HEARTBEAT_SCHEDULER_ENABLED: 'true', HEARTBEAT_SCHEDULER_INTERVAL_MS: '10000',
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
  // Keep logs and workspace evidence, but release the disposable database
  // once its owning host has exited so repeated workflow runs fit in /tmp.
  if(server && server.exitCode!==null) rmSync(join(home,'instances/acceptance/db'),{recursive:true,force:true});
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
    return status.connected === true && output.includes('connected');
  });
  assert.ok(output.includes('connected'));
  try {
    assert.throws(() => cli(['check','--private-dir',privateDir]),error => {
      assert.match(error.stderr.toString(),/already connected.*HTTP 409.*stop.*daemon.*check/);
      assert.doesNotMatch(error.stderr.toString(),/access credentials|registration|revocation|configure/);
      return true;
    });
    assert.equal((await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected,true);
  } finally { daemon.kill('SIGTERM'); }
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
  await eventually(async () => (await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).executionReady);
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

async function startExecutionDaemon(env={},args=[]) {
  const daemon=spawn(join(root,'bin/outpost'),['daemon','--private-dir',privateDir,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  let output=''; daemon.stdout.on('data',data => {output+=data;}); daemon.stderr.on('data',data => {output+=data;});
  await eventually(async () => {
    assert.equal(daemon.exitCode,null,output);
    return (await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).executionReady;
  });
  return daemon;
}
async function stopExecutionDaemon(daemon) {
  daemon.kill('SIGTERM');
  await eventually(async () => !(await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`)).connected);
}

test('actual Pi reads its assigned task through the callback bridge and retains machine runtime assets', {timeout:240000}, async t => {
  const workspace=join(home,'workspaces','pi'); mkdirSync(workspace);
  const runtime=join(home,'pi-runtime'); mkdirSync(runtime);
  const agentDir=join(runtime,'agent'); mkdirSync(agentDir);
  const state=join(runtime,'state'); mkdirSync(state,{mode:0o700});
  const sessions=join(runtime,'sessions'); mkdirSync(sessions);
  const policyPath=join(runtime,'policy.json'),workerPath=join(runtime,'worker.json');
  const node22=process.env.OUTPOST_TEST_NODE22 ?? execFileSync('mise',['where','node@22.22.1'],{encoding:'utf8'}).trim()+'/bin/node';
  let calls=0;
  const provider=createServer(async (req,res) => {
    let input=''; for await(const chunk of req) input+=chunk;
    const body=JSON.parse(input);
    assert.equal(req.headers.authorization,'Bearer machine-provider-key');
    for (const secret of Object.values(proxySecrets)) assert.ok(!JSON.stringify(body).includes(secret),'Access credential reached Pi through runtime or callback input');
    const steps=[
      ['paperclip_coordination',{operation:'task'}],
      ['paperclip_coordination',{operation:'progress',comment:'Pi completed the local fixture check.'}],
      ['paperclip_coordination',{operation:'progress',comment:'x'.repeat(4001)}],
      ['read',{path:workerPath}],
      ['write',{path:policyPath,content:'forbidden config change'}],
      ['bash',{command:'printf \'%s\\n\' "$HOME"'}],
      ...(calls < 8 ? [] : [['read',{path:'pi-effect.txt'}]]),
      ['write',{path:calls < 8 ? 'pi-effect.txt' : 'pi-second-effect.txt',content:'machine-owned Pi effect\n'}],
    ];
    const step=steps[calls < 8 ? calls : (calls-8) % 9];
    if(calls === 15) assert.ok(JSON.stringify(body.messages.at(-1)).includes('machine-owned Pi effect'), 'Second run must read the existing first-run effect');
    if(calls === 1 || calls === 9) assert.ok(JSON.stringify(body.messages.at(-1)).includes('Read the assigned task and report progress'), 'Task callback must return the assigned issue');
    calls++;
    const delta=step ? {role:'assistant',tool_calls:[{index:0,id:`fixture-${calls}`,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]} : {role:'assistant',content:'Assigned task completed.'};
    providerResponse(res,delta,step?'tool_calls':'stop');
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(async()=>{provider.closeAllConnections(); await new Promise(r=>provider.close(r));});
  const modelConfig=JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',apiKey:'${OPENAI_API_KEY}',models:[{id:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}]}}});
  writeFileSync(join(agentDir,'models.json'),modelConfig);
  const authConfig='{"fixture":{"type":"api_key","key":"${OPENAI_API_KEY}"}}';
  writeFileSync(join(agentDir,'auth.json'),authConfig);
  const serverSecret=await json(`/api/companies/${company.id}/secrets`,{name:"Server provider fixture",value:"server-key-must-not-replace-machine-auth"});
  const agent=await json(`/api/companies/${company.id}/agents`,{
    name:'Actual Pi',role:'engineer',adapterType:'pi_local',defaultEnvironmentId:registered.environmentId,
    adapterConfig:{command:join(root,'.cache/pi-config/scripts/paperclip-pi'),cwd:workspace,model:'fixture/fixture',timeoutSec:60,machineSessionDir:sessions,
      env:{OPENAI_API_KEY:{type:'secret_ref',secretId:serverSecret.id},PI_CODING_AGENT_DIR:'/server/runtime/must-not-be-used'}},
  });
  const task=await json(`/api/companies/${company.id}/issues`,{title:'Read the assigned task and report progress',status:'backlog',assigneeAgentId:agent.id});
  const policy=JSON.parse(readFileSync(join(root,'.cache/pi-config/policies/personal.example.json'),'utf8'));
  Object.assign(policy,{projectRoot:workspace,scratchRoots:[],scripts:[]});
  writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
  writeFileSync(workerPath,JSON.stringify({version:1,apiUrl:origin,companyId:company.id,agentId:agent.id,workerId:'fixture',generation:'one',expirySeconds:3600,hostInputs:[]}),{mode:0o600});
  execFileSync('git',['init',workspace],{stdio:'ignore'});
  execFileSync('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@outpost.test','commit','--allow-empty','-m','Machine Pi history'],{stdio:'ignore'});
  const history=execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'});
  // Configure writable runtime state locally through the registration CLI.
  const piPrivate=join(home,'pi-private');
  cli(['configure','--instance',origin,'--private-dir',piPrivate,
    '--workspace-root',join(home,'workspaces'),'--scratch-root',join(home,'scratch')],{headers:proxySecrets});
  const piRegistration=JSON.parse(cli(['register','--company',company.id,'--name','Pi worker','--private-dir',piPrivate],
    {operatorAuthorization:`Bearer ${boardToken}`,runtimeRoots:[state,sessions,agentDir],runtimeEnv:['OPENAI_API_KEY']}));
  await json(`/api/agents/${agent.id}`,{defaultEnvironmentId:piRegistration.environmentId},undefined,'PATCH');
  const daemon=spawn(join(root,'bin/outpost'),['daemon','--private-dir',piPrivate],{env:{...process.env,PATH:node22.slice(0,-5)+':/usr/bin:/bin',
    CF_ACCESS_CLIENT_ID:proxySecrets['CF-Access-Client-Id'],CF_ACCESS_CLIENT_SECRET:proxySecrets['CF-Access-Client-Secret'],
    OPENAI_API_KEY:'machine-provider-key',PI_CODING_AGENT_DIR:agentDir,PI_APPROVAL_POLICY:policyPath,PI_APPROVAL_STATE:state,PI_APPROVAL_PAPERCLIP:workerPath},stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  await eventually(async()=>(await json(`/api/plugins/yelqo.outpost/api/outposts/${piRegistration.outpostId}?companyId=${company.id}`)).executionReady);
  try {
    for(let attempt=0;attempt<2;attempt++) {
      const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{payload:{issueId:task.id}});
      let outcome;
      await eventually(async()=>{outcome=await json(`/api/heartbeat-runs/${run.id}`);return !['queued','running'].includes(outcome.status);},90000);
      assert.equal(outcome.status,'succeeded',JSON.stringify({error:outcome.error,stderr:outcome.stderrExcerpt.slice(-3000),stdout:outcome.stdoutExcerpt.slice(-3000)}));
      const log=await json(`/api/heartbeat-runs/${run.id}/log`);
      assert.match(log.content,/Assigned task completed/);
      assert.match(log.content,/Protected approval\/configuration state/);
      assert.match(log.content,/\/tmp\/pi-home/);
      assert.ok(!log.content.includes('server-key-must-not-replace-machine-auth'));
      assert.ok(!log.content.includes('machine-provider-key'));
      for (const secret of Object.values(proxySecrets)) {
        assert.ok(!log.content.includes(secret),'Access credential present in agent run log');
        assert.ok(!logs.includes(secret),'Access credential present in host log');
      }
      const comments=await json(`/api/issues/${task.id}/comments`);
      assert.equal(comments.length,attempt+1);
      assert.equal(readFileSync(join(workspace,'pi-effect.txt'),'utf8'),'machine-owned Pi effect\n');
      assert.equal(execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}),history);
    }
    assert.equal(readFileSync(join(workspace,'pi-second-effect.txt'),'utf8'),'machine-owned Pi effect\n');
    assert.equal(readFileSync(join(agentDir,'models.json'),'utf8'),modelConfig);
    assert.equal(readFileSync(join(agentDir,'auth.json'),'utf8'),authConfig);
    assert.equal(readFileSync(policyPath,'utf8'),JSON.stringify(policy));
    assert.equal(execFileSync('git',['-C',workspace,'rev-parse','HEAD'],{encoding:'utf8'}),history);
    // A loopback URL supplied as ordinary runtime environment never becomes
    // trusted instance identity, even with explicit server env forwarding.
    const allowedConfig={...agent.adapterConfig,allowServerRuntimeConfig:true,env:{PI_APPROVAL_CALLBACK_URL:'http://127.0.0.1:9'}};
    await json(`/api/agents/${agent.id}`,{adapterConfig:allowedConfig},undefined,'PATCH');
    const providerCalls=calls;
    const rejected=await terminalRun(await json(`/api/agents/${agent.id}/heartbeat/invoke`,{payload:{issueId:task.id}}));
    assert.equal(rejected.status,'failed');
    assert.equal(calls,providerCalls,'Untrusted transport must fail before calling the provider');
  } finally {
    daemon.kill('SIGTERM');
    await eventually(async()=>!(await json(`/api/plugins/yelqo.outpost/api/outposts/${piRegistration.outpostId}?companyId=${company.id}`)).connected);
  }
});
test('actual Pi human approvals preserve continuation, scope and one-time authority', {timeout:600000}, async t => {
  const workspace=join(home,'workspaces','pi-approval'); mkdirSync(workspace);
  const runtime=join(home,'pi-approval-runtime'); mkdirSync(runtime);
  const agentDir=join(runtime,'agent'),state=join(runtime,'state'),sessions=join(runtime,'sessions');
  for(const directory of [agentDir,state,sessions]) mkdirSync(directory,{mode:0o700});
  const policyPath=join(runtime,'policy.json'),workerPath=join(runtime,'worker.json');
  const node22=process.env.OUTPOST_TEST_NODE22 ?? execFileSync('mise',['where','node@22.22.1'],{encoding:'utf8'}).trim()+'/bin/node';
  let calls=0,providerPause,providerReached;
  let command='git commit --allow-empty -m "Human approved effect"';
  const provider=createServer(async (req,res) => {
    let input=''; for await(const chunk of req) input+=chunk;
    const body=JSON.parse(input);
    providerReached?.();
    await providerPause;
    const complete=body.messages.at(-1).role==='tool';
    calls++;
    const delta=complete ? {role:'assistant',content:'Protected operation completed.'} : {role:'assistant',tool_calls:[{index:0,id:`approval-${calls}`,type:'function',function:{name:'bash',arguments:JSON.stringify({command})}}]};
    providerResponse(res,delta,complete?'stop':'tool_calls');
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  t.after(async()=>{provider.closeAllConnections(); await new Promise(r=>provider.close(r));});
  writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,api:'openai-completions',apiKey:'fixture-key',models:[{id:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}]}}}));
  execFileSync('git',['init',workspace],{stdio:'ignore'});
  execFileSync('git',['-C',workspace,'config','user.name','Fixture']);
  execFileSync('git',['-C',workspace,'config','user.email','fixture@outpost.test']);
  execFileSync('git',['-C',workspace,'commit','--allow-empty','-m','Initial history'],{stdio:'ignore'});
  const commits=()=>Number(execFileSync('git',['-C',workspace,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim());
  const agent=await json(`/api/companies/${company.id}/agents`,{
    name:'Human approval Pi',role:'engineer',adapterType:'pi_local',defaultEnvironmentId:registered.environmentId,
    runtimeConfig:{heartbeat:{enabled:false,maxConcurrentRuns:1}},
    adapterConfig:{command:join(root,'.cache/pi-config/scripts/paperclip-pi'),cwd:workspace,model:'fixture/fixture',timeoutSec:60,machineSessionDir:sessions},
  });
  const newTask=title=>json(`/api/companies/${company.id}/issues`,{title,status:'backlog',assigneeAgentId:agent.id});
  let task=await newTask('Commit the approved local effect once');
  const policy=JSON.parse(readFileSync(join(root,'.cache/pi-config/policies/personal.example.json'),'utf8'));
  Object.assign(policy,{projectRoot:workspace,scratchRoots:[],scripts:[]});
  writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
  writeFileSync(workerPath,JSON.stringify({version:1,apiUrl:origin,companyId:company.id,agentId:agent.id,workerId:'approval-fixture',generation:'one',expirySeconds:3600,hostInputs:[]}),{mode:0o600});
  const piPrivate=join(runtime,'connection');
  const registration=JSON.parse(cli(['register','--instance',origin,'--company',company.id,'--name','Human approval worker',
    '--private-dir',piPrivate,'--workspace-root',join(home,'workspaces'),'--scratch-root',join(home,'scratch')],
    {operatorAuthorization:`Bearer ${boardToken}`,runtimeRoots:[state,sessions,agentDir]}));
  await json(`/api/agents/${agent.id}`,{defaultEnvironmentId:registration.environmentId},undefined,'PATCH');
  const daemon=spawn(join(root,'bin/outpost'),['daemon','--private-dir',piPrivate],{env:{...process.env,PATH:node22.slice(0,-5)+':/usr/bin:/bin',
    PI_CODING_AGENT_DIR:agentDir,PI_APPROVAL_POLICY:policyPath,PI_APPROVAL_STATE:state,PI_APPROVAL_PAPERCLIP:workerPath},stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  const statusPath=`/api/plugins/yelqo.outpost/api/outposts/${registration.outpostId}?companyId=${company.id}`;
  await eventually(async()=>(await json(statusPath)).executionReady);
  const interactions=()=>json(`/api/issues/${task.id}/interactions`);
  const approvalRun=async(run)=>{
    for(let retry=0;retry<3;retry++) {
      let outcome;
      await eventually(async()=>{
        outcome=await json(`/api/heartbeat-runs/${run.id}`);
        return !['queued','running','scheduled_retry'].includes(outcome.status);
      },60000);
      if(outcome.errorCode!=='execution_unavailable') return outcome;
      run=await scheduledRetry(outcome);
    }
    assert.fail('Approval continuation remained unavailable after scheduler retries');
  };
  const invoke=async()=>{
    const before=new Set((await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`)).map(run=>run.id));
    // Manual retries explicitly leave the task's human-review posture. This
    // changes scheduling, while the durable approval still decides authority.
    if(['in_review','done'].includes((await json(`/api/issues/${task.id}`)).status)) {
      await json(`/api/issues/${task.id}`,{status:'in_progress'},undefined,'PATCH');
    }
    let run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{reason:'manual_approval_check',payload:{issueId:task.id}});
    if(!run.id) {
      const observed=await json(`/api/issues/${task.id}`);
      const pendingRun=observed.scheduledRetry?.runId ?? observed.executionRunId;
      assert.ok(pendingRun,JSON.stringify({run,taskStatus:observed.status,blocker:observed.executionBlocker}));
      run=await json(`/api/heartbeat-runs/${pendingRun}`);
      assert.ok(!before.has(run.id) || ['queued','running','scheduled_retry'].includes(run.status),JSON.stringify(run));
    }
    return approvalRun(run);
  };
  const decisionRun=async(card,decision)=>{
    const before=new Set((await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`)).map(run=>run.id));
    await json(`/api/issues/${task.id}/interactions/${card.id}/${decision}`,{});
    let continuation;
    await eventually(async()=>{
      continuation=(await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`)).find(run=>!before.has(run.id) && run.contextSnapshot?.interactionId===card.id);
      if(!continuation) {
        const observed=await json(`/api/issues/${task.id}`);
        const pendingRun=observed.scheduledRetry?.runId ?? observed.executionRunId;
        if(pendingRun) {
          const candidate=await json(`/api/heartbeat-runs/${pendingRun}`);
          if(candidate.contextSnapshot?.interactionId===card.id) continuation=candidate;
        }
      }
      return continuation;
    });
    continuation=await approvalRun(continuation);
    assert.equal(continuation.contextSnapshot.interactionId,card.id);
    return continuation;
  };
  try {
    const first=await invoke();
    const cards=await interactions();
    assert.equal(cards.length,1,JSON.stringify({first,cards}));
    const card=cards[0];
    assert.equal(card.status,'pending');
    assert.equal(card.effectiveResolverPolicy,'human_only');
    assert.equal(card.continuationPolicy,'wake_assignee');
    assert.equal((await json(`/api/issues/${task.id}`)).status,'in_review');
    assert.equal(commits(),1,'Pending approval cannot execute');
    const agentKey=await json(`/api/agents/${agent.id}/keys`,{name:'Cannot decide human approval'});
    const agentDecision=await fetch(`${origin}/api/issues/${task.id}/interactions/${card.id}/accept`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${agentKey.token}`,'X-Paperclip-Run-Id':first.id},body:'{}',
    });
    assert.ok([403,422].includes(agentDecision.status));
    assert.match(await agentDecision.text(),/human/i);
    const continuation=await decisionRun(card,'accept');
    assert.equal(continuation.sessionIdBefore,first.sessionIdAfter,'Human wake must reuse the Pi session');
    assert.equal(continuation.sessionIdAfter,first.sessionIdAfter);
    assert.equal(commits(),2,JSON.stringify(continuation));
    await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');

    // A consumed approval cannot execute on a duplicate wake or decision.
    {
      task=await newTask('Consume an unchanged operation once');
      command='git --version';
      await invoke();
      const pending=(await interactions()).find(card=>card.status==='pending');
      assert.ok(pending);
      const allowed=await decisionRun(pending,'accept');
      assert.equal(allowed.status,'succeeded',JSON.stringify(allowed));
      assert.match((await json(`/api/heartbeat-runs/${allowed.id}/log?limitBytes=1048576`)).content,/git version \d+\./);
      await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
      const replay=await invoke();
      assert.equal(replay.status,'failed',JSON.stringify({status:replay.status,error:replay.error,errorCode:replay.errorCode}));
      assert.match((await json(`/api/heartbeat-runs/${replay.id}/log?limitBytes=1048576`)).content,/Saved approval consumed/);
      assert.equal((await interactions()).length,1);
      const repeated=await api(`/api/issues/${task.id}/interactions/${pending.id}/accept`,{});
      assert.ok([200,409].includes(repeated.status));
      assert.equal(commits(),2);
      await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
    }

    // A descriptor presented to the actual launcher cannot change run scope
    // or replace the configured instance with an arbitrary callback endpoint.
    {
      const wrapper=join(runtime,'forged-transport.mjs'),override=join(runtime,'override.json');
      const injected=join(state,'injected-transport.json');
      writeFileSync(wrapper,`#!${node22}
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const descriptor=JSON.parse(readFileSync(process.env.PI_APPROVAL_TRANSPORT,'utf8'));
const override=JSON.parse(readFileSync(${JSON.stringify(override)},'utf8'));
writeFileSync(${JSON.stringify(injected)},JSON.stringify({...descriptor,...override}),{mode:0o600});
const child=spawnSync(${JSON.stringify(agent.adapterConfig.command)},process.argv.slice(2),{env:{...process.env,PI_APPROVAL_TRANSPORT:${JSON.stringify(injected)}},stdio:'inherit'});
unlinkSync(${JSON.stringify(injected)});
process.exit(child.status ?? 1);
`,{mode:0o700});
      await json(`/api/agents/${agent.id}`,{adapterConfig:{...agent.adapterConfig,command:wrapper}},undefined,'PATCH');
      try {
        for(const overrideValue of [
          {runId:'00000000-0000-4000-8000-000000000001'},
          {taskId:'00000000-0000-4000-8000-000000000002'},
          {companyId:'00000000-0000-4000-8000-000000000003'},
          {agentId:'00000000-0000-4000-8000-000000000004'},
          {instance:'http://127.0.0.1:9'},
          {callbackUrl:'https://example.invalid'},
          {expiresAt:'1970-01-01T00:00:00.000Z'},
        ]) {
          task=await newTask(`Reject forged approval transport: ${Object.keys(overrideValue)[0]}`);
          writeFileSync(override,JSON.stringify(overrideValue),{mode:0o600});
          const beforeCalls=calls;
          const rejected=await invoke();
          assert.equal(rejected.status,'failed',JSON.stringify(rejected));
          assert.equal(calls,beforeCalls,'Forged scope must fail before the provider runs');
          assert.equal(commits(),2);
          await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
        }
        assert.equal((await interactions()).length,0);
      } finally {
        await json(`/api/agents/${agent.id}`,{adapterConfig:agent.adapterConfig},undefined,'PATCH');
      }
    }

    // A human denial and later wake prevent the protected workspace effect.
    {
      task=await newTask('Deny the protected effect');
      command='git commit --allow-empty -m "Denied effect"';
      await invoke();
      const pending=(await interactions()).find(card=>card.status==='pending');
      assert.ok(pending);
      const denied=await decisionRun(pending,'reject');
      assert.match((await json(`/api/heartbeat-runs/${denied.id}/log?limitBytes=1048576`)).content,/Human request denied/);
      assert.equal(commits(),2);
      const replay=await invoke();
      assert.match((await json(`/api/heartbeat-runs/${replay.id}/log?limitBytes=1048576`)).content,/Saved approval denied/);
      assert.equal((await interactions()).length,1);
      assert.equal(commits(),2);
      await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
    }

    // Changing the operation withdraws the old card through the bridge.
    {
      task=await newTask('Withdraw changed operation scope');
      command='git commit --allow-empty -m "Old scope"';
      await invoke();
      const old=(await interactions()).find(card=>card.status==='pending');
      assert.ok(old);
      command='git commit --allow-empty -m "Changed scope"';
      await invoke();
      const cards=await interactions();
      assert.equal(cards.find(card=>card.id===old.id).status,'cancelled');
      assert.equal(cards.filter(card=>card.status==='pending').length,1);
      assert.equal(commits(),2);
      await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
    }

    // Losing the real decision channel during a running Pi attempt never
    // authorizes the pending operation, and reconnecting does not decide it.
    {
      task=await newTask('Keep approval blocked during channel loss');
      command='git commit --allow-empty -m "Unavailable channel effect"';
      await invoke();
      const pending=(await interactions()).find(card=>card.status==='pending');
      assert.ok(pending);
      let releaseProvider;
      providerPause=new Promise(resolve=>{releaseProvider=resolve;});
      const reached=new Promise(resolve=>{providerReached=resolve;});
      let disabled=false;
      try {
        const attempt=invoke();
        await reached;
        await json('/api/plugins/yelqo.outpost/disable',{});
        disabled=true;
        releaseProvider(); providerPause=undefined; providerReached=undefined;
        const interrupted=await attempt;
        assert.equal(interrupted.status,'failed');
        assert.equal(commits(),2);
        // pi-config bounds each channel request to ten seconds. Let the
        // isolated attempt settle before re-establishing the decision channel.
        await delay(15000);
        await json('/api/plugins/yelqo.outpost/enable',{});
        disabled=false;
        await eventually(async()=>(await json(statusPath)).executionReady,20000);
        assert.equal((await interactions()).find(card=>card.id===pending.id).status,'pending');
        assert.equal(commits(),2,'Reconnection cannot approve the operation');
        const wake=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{reason:'manual_approval_check',payload:{issueId:task.id}});
        if(wake.id) {
          const retry=await approvalRun(wake);
          assert.match((await json(`/api/heartbeat-runs/${retry.id}/log?limitBytes=1048576`)).content,/Waiting for authenticated human response/);
        } else {
          // Active-run transport recovery belongs to the recovery milestone.
          // Its retained lease may keep admission blocked after reconnection.
          assert.equal(wake.status,'skipped');
          assert.ok((await json(`/api/issues/${task.id}`)).executionBlocker);
        }
        assert.equal(commits(),2);
        await json(`/api/issues/${task.id}`,{status:'done'},undefined,'PATCH');
      } finally {
        releaseProvider(); providerPause=undefined; providerReached=undefined;
        if(disabled) await json('/api/plugins/yelqo.outpost/enable',{});
      }
    }
  } finally {
    daemon.kill('SIGTERM');
    await eventually(async()=>!(await json(statusPath)).connected);
  }
});

async function commandAgent(cwd,args,extra={}) {
  const {defaultEnvironmentId=registered.environmentId,adapterType='process',...adapterConfig}=extra;
  return json(`/api/companies/${company.id}/agents`,{
    name:'Execution fixture',role:'engineer',adapterType,defaultEnvironmentId,
    adapterConfig:{command:'/bin/sh',args:['-c',args],cwd,timeoutSec:5,...adapterConfig},
  });
}
async function terminalRun(run,timeout=15000) {
  let outcome;
  await eventually(async () => {
    outcome=await json(`/api/heartbeat-runs/${run.id}`);
    return !['queued','running'].includes(outcome.status);
  },timeout);
  return outcome;
}

async function scheduledRetry(run) {
  let retry;
  await eventually(async () => {
    const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${run.agentId}`);
    retry=runs.find(value => value.retryOfRunId===run.id);
    return retry?.status==='scheduled_retry';
  });
  return json(`/api/heartbeat-runs/${retry.id}`);
}

test('offline work stays pending in Paperclip and the scheduler launches it after reconnection', {timeout:60000}, async () => {
  const workspace=join(home,'workspaces','offline'); mkdirSync(workspace);
  const agent=await commandAgent(workspace,'echo once >> launches');
  const task=await json(`/api/companies/${company.id}/issues`,{title:'Pending offline task',status:'backlog',assigneeAgentId:agent.id});
  const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{payload:{issueId:task.id}});
  const outcome=await terminalRun(run);
  assert.equal(outcome.status,'cancelled',JSON.stringify(outcome));
  assert.equal(outcome.errorCode,'execution_unavailable');
  const retry=await scheduledRetry(run);
  assert.equal(retry.scheduledRetryReason,'execution_unavailable');
  assert.equal(retry.contextSnapshot.issueId,task.id);
  assert.equal(retry.contextSnapshot.executionRetryAccounting.failureRetries,0);
  assert.equal((await json(`/api/issues/${task.id}`)).scheduledRetry.runId,retry.id);
  assert.equal(existsSync(join(workspace,'launches')),false);
  const daemon=await startExecutionDaemon();
  try {
    let result;
    await eventually(async () => {
      result=await json(`/api/heartbeat-runs/${retry.id}`);
      return result.status==='succeeded';
    },45000);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'once\n');
  } finally { await stopExecutionDaemon(daemon); }
});

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

async function installExecutionAdapter(adapterType='process') {
  const fixture=join(home,`${adapterType}-execution-adapter`);
  mkdirSync(fixture,{recursive:true});
  writeFileSync(join(fixture,'package.json'),JSON.stringify({name:`@yelqo/acceptance-${adapterType}-execution-adapter`,version:'1.0.0',type:'module',main:'index.mjs'}));
  copyFileSync(join(root,'tests/fixtures/execution-adapter.mjs'),join(fixture,'execution.mjs'));
  writeFileSync(join(fixture,'index.mjs'),`import {createServerAdapter as adapter} from './execution.mjs';\nexport function createServerAdapter() { return adapter(${JSON.stringify(adapterType)}); }\n`);
  await json('/api/adapters/install',{packageName:fixture,isLocalPath:true});
  await json(`/api/adapters/${adapterType}/override`,{paused:false},cookie,'PATCH');
}
async function removeExecutionAdapter(adapterType='process') {
  // The pinned host retains process overrides on uninstall; pause it through
  // the public API first so following tests use the built-in process adapter.
  await json(`/api/adapters/${adapterType}/override`,{paused:true},cookie,'PATCH');
  const response=await api(`/api/adapters/${adapterType}`,undefined,cookie,'DELETE');
  assert.ok(response.ok,await response.text());
}

test('restoring a machine snapshot reports missing history and never authorizes another launch', {timeout:60000}, async () => {
  const snapshot=join(home,'history-snapshot');
  cpSync(privateDir,snapshot,{recursive:true});
  let daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','history-rollback'); mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo effect >> launches');
    const runs=[];
    for(let attempt=0;attempt<2;attempt++) {
      const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{});
      assert.equal((await terminalRun(run)).status,'succeeded');
      runs.push(run);
    }
    await stopExecutionDaemon(daemon);
    rmSync(privateDir,{recursive:true});
    cpSync(snapshot,privateDir,{recursive:true});
    chmodSync(privateDir,0o700);
    daemon=await startExecutionDaemon();
    const status=await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`);
    for(const run of runs) assert.ok(status.executionHistory.some(record => record.runId===run.id && record.historyMissing && record.status==='uncertain'),JSON.stringify(status));
    const competing=await commandAgent(workspace,'echo duplicate >> launches');
    const conflict=await json(`/api/agents/${competing.id}/heartbeat/invoke`,{});
    assert.equal((await terminalRun(conflict)).status,'cancelled');
    await json(`/api/heartbeat-runs/${(await scheduledRetry(conflict)).id}/cancel`,{});
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'effect\neffect\n');
  } finally { await stopExecutionDaemon(daemon); }
});

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

test('aliases of separate Paperclip workspace records defer while controls and distinct directories execute, then retry automatically', {timeout:90000}, async () => {
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
    const project=await json(`/api/companies/${company.id}/projects`,{name:'Shared outpost directories'});
    const task=async (agent,cwd) => {
      const record=await json(`/api/projects/${project.id}/workspaces`,{name:agent.id,cwd});
      return json(`/api/companies/${company.id}/issues`,{title:agent.id,status:'backlog',projectId:project.id,projectWorkspaceId:record.id,assigneeAgentId:agent.id});
    };
    const ownerTask=await task(owner,workspace), competingTask=await task(competing,alias), parallelTask=await task(parallel,separate);
    const invoke=(agent,task) => json(`/api/agents/${agent.id}/heartbeat/invoke`,{payload:{issueId:task.id}});
    const run=await invoke(owner,ownerTask);
    await eventually(async () => {
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      if(response.status===404) return false;
      assert.ok(response.ok);
      const log=await response.json();
      return log.content?.includes('holding-workspace');
    });
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running','stdout must stream before exit');
    await eventually(() => existsSync(join(workspace,'control')));
    const conflictRun=await invoke(competing,competingTask);
    const parallelRun=await invoke(parallel,parallelTask);
    const conflict=await terminalRun(conflictRun);
    assert.equal(conflict.status,'cancelled',JSON.stringify(conflict));
    assert.match(conflict.error,/busy/);
    const retry=await scheduledRetry(conflictRun);
    assert.equal((await json(`/api/issues/${competingTask.id}`)).scheduledRetry.runId,retry.id);
    assert.equal((await terminalRun(parallelRun)).status,'succeeded');
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'agent\n');
    writeFileSync(join(workspace,'allow-finish'),'');
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.controlSucceeded,true);
    assert.equal(readFileSync(join(workspace,'control'),'utf8'),'control\n');
    assert.equal(readFileSync(join(separate,'effect'),'utf8'),'separate\n');
    await eventually(async () => (await json(`/api/heartbeat-runs/${retry.id}`)).status==='succeeded',45000);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'agent\ncompeting\n');
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

test('a control before agent launch excludes conflicting work after plugin restart until it terminates', {timeout:90000}, async () => {
  await installExecutionAdapter();
  const daemon=await startExecutionDaemon();
  const workspace=join(home,'workspaces','control-ownership');
  const independent=join(home,'workspaces','control-independent');
  mkdirSync(workspace); mkdirSync(independent);
  const statusPath=`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`;
  let disabled=false;
  try {
    const owner=await commandAgent(workspace,'',{scenario:'control-ownership'});
    const run=await json(`/api/agents/${owner.id}/heartbeat/invoke`,{});
    await eventually(() => existsSync(join(workspace,'control')));
    await json('/api/plugins/yelqo.outpost/disable',{});
    disabled=true;
    await json('/api/plugins/yelqo.outpost/enable',{});
    disabled=false;
    await eventually(async () => (await json(statusPath)).executionReady,20000);
    assert.equal((await terminalRun(run)).status,'failed');
    assert.equal(existsSync(join(workspace,'finished-control')),false,'control must still be executing after transport loss');
    const competing=await commandAgent(workspace,'echo conflicting >> launches');
    const conflict=await json(`/api/agents/${competing.id}/heartbeat/invoke`,{});
    const outcome=await terminalRun(conflict);
    assert.equal(outcome.status,'cancelled',JSON.stringify(outcome));
    assert.equal(outcome.errorCode,'execution_unavailable');
    const retry=await scheduledRetry(conflict);
    await json(`/api/heartbeat-runs/${retry.id}/cancel`,{});
    assert.equal(existsSync(join(workspace,'launches')),false);
    const parallel=await commandAgent(independent,'echo independent > effect');
    assert.equal((await terminalRun(await json(`/api/agents/${parallel.id}/heartbeat/invoke`,{}))).status,'succeeded');
    assert.equal(readFileSync(join(independent,'effect'),'utf8'),'independent\n');
    writeFileSync(join(workspace,'finish-control'),'');
    await eventually(() => existsSync(join(workspace,'finished-control')));
    let recovered;
    await eventually(async () => {
      const status=await json(statusPath);
      recovered=status.executionHistory.find(record=>record.runId===run.id && record.purpose==='control');
      return recovered?.status==='terminal' && status.outputRetention?.operations===0;
    });
    const output=await json(`${statusPath.replace('?','/output?')}&operationId=${encodeURIComponent(recovered.operationId)}`);
    assert.equal(output.chunks.map(chunk=>Buffer.from(chunk.data,'base64').toString()).join(''),'before-restartafter-restart');
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'failed','recovered output must not rewrite a completed heartbeat');
    const after=await json(`/api/agents/${competing.id}/heartbeat/invoke`,{});
    assert.equal((await terminalRun(after)).status,'succeeded');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'conflicting\n');
  } finally {
    writeFileSync(join(workspace,'finish-control'),'');
    if(disabled) await json('/api/plugins/yelqo.outpost/enable',{});
    await stopExecutionDaemon(daemon);
    await removeExecutionAdapter();
  }
});

test('execution stops at its output limit and retains the workspace',async () => {
  await installExecutionAdapter();
  const daemon=await startExecutionDaemon({},['--output-buffer-bytes','4096','--output-total-bytes','8192']);
  const workspace=join(home,'workspaces','output-limit');
  mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch > launches; while ! test -e exhaust; do sleep .1; done; (sleep 2; echo escaped > escaped) & printf \'{"status":"success"}\\n\'; yes output');
    const task=await json(`/api/companies/${company.id}/issues`,{title:'Exhaustion requires operator continuation',status:'in_progress',assigneeAgentId:agent.id});
    await eventually(()=>existsSync(join(workspace,'launches')));
    assert.equal((await json(`/api/issues/${task.id}`)).status,'in_progress','failure must exercise recovery of an active task');
    const [run]=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    writeFileSync(join(workspace,'exhaust'),'');
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'failed',JSON.stringify(outcome));
    assert.match(outcome.error,/output limit/);
    assert.equal(outcome.errorCode,'output_limit');
    assert.equal(outcome.resultJson.stopReason,'adapter_failed','partial structured output must never become an adapter success');
    assert.equal(outcome.resultJson.stdout,undefined);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
    const statusPath=`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`;
    let receipt;
    await eventually(async () => {
      const status=await json(statusPath);
      receipt=status.executionHistory.find(record=>record.runId===outcome.id);
      return receipt?.status==='terminal' && status.outputRetention?.operations===0;
    });
    assert.match(receipt.outcome.error,/output limit/);
    const recovered=await json(`${statusPath.replace('?','/output?')}&operationId=${encodeURIComponent(receipt.operationId)}`);
    assert.ok(recovered.receipt.bytes>0 && recovered.receipt.bytes<4096);
    await delay(2100);
    assert.equal(existsSync(join(workspace,'escaped')),false,'exhaustion must stop descendants');
    assert.equal((await json(`/api/issues/${task.id}`)).scheduledRetry,null,'exhaustion cannot schedule a replacement');
    await stopExecutionDaemon(daemon);
    const restarted=await startExecutionDaemon();
    try {
      const status=await json(statusPath);
      assert.match(status.executionHistory.find(record=>record.operationId===receipt.operationId).outcome.error,/output limit/);
      assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
      const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
      assert.equal(runs.length,1,'exhaustion cannot trigger automatic relaunch');
    } finally { await stopExecutionDaemon(restarted); }
  } finally { await stopExecutionDaemon(daemon); await removeExecutionAdapter(); }
});

async function bufferedOutpost(t,name,daemonArgs=[]) {
  let blocked=false;
  const sockets=new Set();
  const proxy=createTCPServer(client => {
    if(blocked) { client.destroy(); return; }
    const upstream=connectTCP({host:'127.0.0.1',port});
    for(const socket of [client,upstream]) {
      sockets.add(socket);
      socket.on('error',()=>{client.destroy(); upstream.destroy();});
      socket.on('close',()=>sockets.delete(socket));
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets) socket.destroy(); proxy.close();});
  const privatePath=join(home,`${name}-private`);
  const enrollment=spawn(join(root,'bin/outpost'),['register','--instance',`http://127.0.0.1:${proxy.address().port}`,'--company',company.id,
    '--name',name,'--private-dir',privatePath,'--workspace-root',join(home,'workspaces'),'--scratch-root',join(home,'scratch')]);
  let enrolled='',enrollmentError='';
  enrollment.stdout.on('data',data=>{enrolled+=data;});
  enrollment.stderr.on('data',data=>{enrollmentError+=data;});
  enrollment.stdin.end(JSON.stringify({operatorAuthorization:`Bearer ${boardToken}`}));
  assert.equal(await new Promise(resolve=>enrollment.once('close',resolve)),0,enrollmentError);
  const outpost=JSON.parse(enrolled);
  const daemon=spawn(join(root,'bin/outpost'),['daemon','--private-dir',privatePath,...daemonArgs],{stdio:['ignore','pipe','pipe']});
  processes.push(daemon);
  const statusPath=`/api/plugins/yelqo.outpost/api/outposts/${outpost.outpostId}?companyId=${company.id}`;
  t.after(async ()=>{
    blocked=false;
    if(daemon.exitCode===null && daemon.signalCode===null) {
      daemon.kill('SIGTERM');
      await new Promise(resolve=>daemon.once('exit',resolve));
    }
  });
  await eventually(async ()=>(await json(statusPath)).executionReady);
  return {outpost,statusPath,disconnect(){blocked=true; for(const socket of sockets) socket.destroy();},reconnect(){blocked=false;}};
}

test('a disconnected execution recovers ordered output and succeeds without another launch', {timeout:60000}, async t => {
  await installExecutionAdapter();
  const transport=await bufferedOutpost(t,'buffered-output');
  const {outpost,statusPath}=transport;
  const workspace=join(home,'workspaces','buffered-output'); mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch >> launches; printf start; while ! test -e release; do sleep .1; done; printf \'{"ok":true}\\n\'; printf recovered-error >&2; echo completed > completed',{defaultEnvironmentId:outpost.environmentId,timeoutSec:30});
    const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{});
    await eventually(async ()=>{
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      return response.ok && (await response.json()).content.includes('start');
    });
    transport.disconnect();
    await eventually(async ()=>!(await json(statusPath)).connected);
    writeFileSync(join(workspace,'release'),'');
    await eventually(()=>existsSync(join(workspace,'completed')));
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running');
    transport.reconnect();
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.stdout,'start{"ok":true}\n');
    assert.equal(outcome.resultJson.stderr,'recovered-error');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
    let status;
    await eventually(async ()=>{status=await json(statusPath); return status.outputRetention?.operations===0;});
    const record=status.executionHistory.find(record=>record.runId===run.id);
    const retained=await json(`${statusPath.replace('?','/output?')}&operationId=${encodeURIComponent(record.operationId)}`);
    assert.equal(retained.chunks.filter(chunk=>chunk.stream==='stdout').map(chunk=>Buffer.from(chunk.data,'base64').toString()).join(''),'start{"ok":true}\n');
  } finally { transport.reconnect(); await removeExecutionAdapter(); }
});

test('default execution survives an outage beyond the host RPC default and repeated reconnects', {timeout:120000}, async t => {
  await installExecutionAdapter();
  const transport=await bufferedOutpost(t,'default-outage');
  const {outpost,statusPath}=transport;
  const workspace=join(home,'workspaces','default-outage'); mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch >> launches; printf started; while ! test -e release; do sleep .1; done; printf finished; echo preserved > completed',
      {defaultEnvironmentId:outpost.environmentId,timeoutSec:0});
    const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{});
    await eventually(async ()=>{
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      return response.ok && (await response.json()).content.includes('started');
    });
    transport.disconnect();
    await eventually(async ()=>!(await json(statusPath)).connected);
    transport.reconnect();
    await eventually(async ()=>(await json(statusPath)).executionReady);
    const active=(await json(statusPath)).executionHistory.find(record=>record.runId===run.id);
    assert.equal(active.status,'running');
    const competingAgent=await commandAgent(workspace,'echo conflicting > conflicting',{defaultEnvironmentId:outpost.environmentId});
    const competing=await terminalRun(await json(`/api/agents/${competingAgent.id}/heartbeat/invoke`,{}));
    assert.equal(competing.status,'cancelled',JSON.stringify(competing));
    assert.equal(competing.errorCode,'execution_unavailable');
    await scheduledRetry(competing);
    assert.equal(existsSync(join(workspace,'conflicting')),false,'reconnecting must preserve the active workspace owner');
    transport.disconnect();
    await eventually(async ()=>!(await json(statusPath)).connected);
    writeFileSync(join(workspace,'release'),'');
    await eventually(()=>existsSync(join(workspace,'completed')));
    // The host's generic RPC deadline is 30 seconds; Outpost's original
    // default execution deadline is 60 seconds, plus reconciliation grace.
    await delay(32000);
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running');
    transport.reconnect();
    // The daemon's retry backoff is bounded at 30 seconds after a long outage.
    const outcome=await terminalRun(run,35000);
    assert.equal(outcome.status,'succeeded',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.stdout,'startedfinished');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
    assert.equal(readFileSync(join(workspace,'completed'),'utf8'),'preserved\n');
    const log=await json(`/api/heartbeat-runs/${run.id}/log`);
    assert.equal(log.content.split('started').length-1,1);
    assert.equal(log.content.split('finished').length-1,1);
    await eventually(async ()=>{
      const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${competingAgent.id}`);
      return runs.some(value=>value.status==='succeeded');
    },30000);
    assert.equal(readFileSync(join(workspace,'conflicting'),'utf8'),'conflicting\n');
  } finally { transport.reconnect(); await removeExecutionAdapter(); }
});

test('a disconnected execution reaches its original deadline and reconciles timeout without relaunch', {timeout:60000}, async t => {
  await installExecutionAdapter();
  const transport=await bufferedOutpost(t,'outage-deadline');
  const {outpost,statusPath}=transport;
  const workspace=join(home,'workspaces','outage-deadline'); mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch >> launches; printf started; (sleep 4; echo escaped > escaped) & wait',
      {defaultEnvironmentId:outpost.environmentId,timeoutSec:2});
    const run=await json(`/api/agents/${agent.id}/heartbeat/invoke`,{});
    await eventually(async ()=>{
      const response=await api(`/api/heartbeat-runs/${run.id}/log`);
      return response.ok && (await response.json()).content.includes('started');
    });
    const active=(await json(statusPath)).executionHistory.find(record=>record.runId===run.id);
    transport.disconnect();
    await eventually(async ()=>!(await json(statusPath)).connected);
    await delay(2500);
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).status,'running');
    transport.reconnect();
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'timed_out',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.stdout,'started');
    const terminal=(await json(statusPath)).executionHistory.find(record=>record.runId===run.id);
    assert.equal(terminal.status,'terminal');
    assert.equal(terminal.deadline,active.deadline);
    assert.equal(terminal.outcome.timedOut,true);
    await delay(2000);
    assert.equal(existsSync(join(workspace,'escaped')),false,'the original deadline must stop descendants during an outage');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
  } finally { transport.reconnect(); await removeExecutionAdapter(); }
});

test('late recovered exhaustion cannot automatically continue a Pi task after grace expiry', {timeout:90000}, async t => {
  await installExecutionAdapter('pi_local');
  const transport=await bufferedOutpost(t,'late-exhaustion',['--output-buffer-bytes','4096','--output-total-bytes','8192']);
  const {outpost,statusPath}=transport;
  const workspace=join(home,'workspaces','late-exhaustion'); mkdirSync(workspace);
  try {
    const agent=await commandAgent(workspace,'echo launch >> launches; printf started; while ! test -e exhaust; do sleep .1; done; (sleep 2; echo escaped > escaped) & yes output',
      {adapterType:'pi_local',defaultEnvironmentId:outpost.environmentId});
    const task=await json(`/api/companies/${company.id}/issues`,{title:'Late exhaustion requires operator continuation',status:'in_progress',assigneeAgentId:agent.id});
    await eventually(async ()=>{
      const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
      if(!runs[0]) return false;
      const response=await api(`/api/heartbeat-runs/${runs[0].id}/log`);
      return response.ok && (await response.json()).content.includes('started');
    });
    const [run]=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    transport.disconnect();
    await eventually(async ()=>!(await json(statusPath)).connected);
    writeFileSync(join(workspace,'exhaust'),'');
    let outcome;
    await eventually(async ()=>{outcome=await json(`/api/heartbeat-runs/${run.id}`); return outcome.status==='failed';},30000);
    assert.equal(outcome.errorCode,'execution_outcome_uncertain',JSON.stringify(outcome));
    assert.match(outcome.error,/outcome is uncertain/);
    assert.equal(outcome.resultJson.conversationContinuation,'continue_conversation_v1','exercise the Pi recovery policy that bypasses the legacy hold');
    transport.reconnect();
    let receipt;
    await eventually(async ()=>{
      const status=await json(statusPath);
      receipt=status.executionHistory.find(record=>record.runId===run.id);
      return status.executionReady && receipt?.status==='terminal' && status.outputRetention?.operations===0;
    });
    assert.equal(receipt.outcome.error,'output limit exceeded');
    const recovered=await json(`${statusPath.replace('?','/output?')}&operationId=${encodeURIComponent(receipt.operationId)}`);
    assert.ok(recovered.receipt.bytes>0 && recovered.receipt.bytes<4096);
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).errorCode,'execution_outcome_uncertain','late receipts must not rewrite completed attempts');
    // The real scheduler runs every 10 seconds. Observe two sweeps after the
    // recovered terminal receipt has released the workspace fence.
    await delay(21000);
    const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    assert.equal(runs.length,1,'conversation continuation must not create a replacement run');
    const observed=await json(`/api/issues/${task.id}`);
    assert.equal(observed.status,'blocked','the periodic recovery sweep must recognize the nonretryable failure');
    assert.equal(observed.scheduledRetry,null);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
    assert.equal(existsSync(join(workspace,'escaped')),false,'buffer exhaustion must stop descendants');
  } finally { transport.reconnect(); await removeExecutionAdapter('pi_local'); }
});

test('worker restart cannot automatically continue a Pi task after recovered exhaustion', {timeout:90000}, async t => {
  await installExecutionAdapter('pi_local');
  const transport=await bufferedOutpost(t,'worker-exhaustion',['--output-buffer-bytes','4096','--output-total-bytes','8192']);
  const {outpost,statusPath}=transport;
  const workspace=join(home,'workspaces','worker-exhaustion'); mkdirSync(workspace);
  let disabled=false;
  try {
    const agent=await commandAgent(workspace,'echo launch >> launches; printf started; while ! test -e exhaust; do sleep .1; done; (sleep 2; echo escaped > escaped) & yes output',
      {adapterType:'pi_local',defaultEnvironmentId:outpost.environmentId});
    const task=await json(`/api/companies/${company.id}/issues`,{title:'Worker loss requires operator continuation',status:'in_progress',assigneeAgentId:agent.id});
    await eventually(()=>existsSync(join(workspace,'launches')));
    const [run]=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    // Withhold the terminal receipt until the host has observed worker loss.
    transport.disconnect();
    await json('/api/plugins/yelqo.outpost/disable',{}); disabled=true;
    writeFileSync(join(workspace,'exhaust'),'');
    await json('/api/plugins/yelqo.outpost/enable',{}); disabled=false;
    const outcome=await terminalRun(run);
    assert.equal(outcome.status,'failed');
    assert.equal(outcome.errorCode,'execution_outcome_uncertain',JSON.stringify(outcome));
    assert.equal(outcome.resultJson.conversationContinuation,'continue_conversation_v1');
    transport.reconnect();
    let receipt;
    await eventually(async ()=>{
      const status=await json(statusPath);
      receipt=status.executionHistory.find(record=>record.runId===run.id);
      return status.executionReady && receipt?.status==='terminal' && status.outputRetention?.operations===0;
    });
    assert.equal(receipt.outcome.error,'output limit exceeded');
    const recovered=await json(`${statusPath.replace('?','/output?')}&operationId=${encodeURIComponent(receipt.operationId)}`);
    assert.ok(recovered.receipt.bytes>0 && recovered.receipt.bytes<4096);
    assert.equal((await json(`/api/heartbeat-runs/${run.id}`)).errorCode,'execution_outcome_uncertain');
    // Observe two real scheduler sweeps after terminal recovery clears ownership.
    await delay(21000);
    const runs=await json(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
    assert.equal(runs.length,1,'worker loss and late exhaustion must not create automatic replacement attempts');
    const observed=await json(`/api/issues/${task.id}`);
    assert.equal(observed.status,'blocked');
    assert.equal(observed.scheduledRetry,null);
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'launch\n');
    assert.equal(existsSync(join(workspace,'escaped')),false);
  } finally {
    transport.reconnect();
    if(disabled) await json('/api/plugins/yelqo.outpost/enable',{});
    await removeExecutionAdapter('pi_local');
  }
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

test('daemon interruption reports verified process loss and frees the workspace without replay', {timeout:60000}, async () => {
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
    // A disconnected request remains pending through its 5-second deadline
    // and 10-second grace period; leave room for host finalization afterward.
    await terminalRun(run,20000);
    daemon=await startExecutionDaemon();
    let recovered;
    await eventually(async () => {
      const status=await json(`/api/plugins/yelqo.outpost/api/outposts/${registered.outpostId}?companyId=${company.id}`);
      recovered=status.executionHistory.find(record=>record.runId===run.id);
      return recovered?.status==='interrupted';
    });
    assert.equal(recovered.outcome.interrupted,true);
    assert.equal(recovered.outcome.ownershipUncertain,undefined);
    const second=await commandAgent(workspace,'echo next >> launches');
    assert.equal((await terminalRun(await json(`/api/agents/${second.id}/heartbeat/invoke`,{}))).status,'succeeded');
    assert.equal(readFileSync(join(workspace,'launches'),'utf8'),'effect\nnext\n');
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

test('same-UID runtime isolation hides execution history, connection files and the daemon process namespace', () => {
  const privateFile = join(privateDir,'connection.json');
  // Ordinary same-UID permissions do allow a read: the launcher must add isolation.
  assert.ok(readFileSync(privateFile,'utf8').includes(connection().credential));
  const historyFile=join(privateDir,readdirSync(privateDir).find(name=>/^operation-.*\.json$/.test(name)));
  const history=readFileSync(historyFile,'utf8');
  const output = cli(['protect','--private-dir',privateDir,'--','/bin/sh','-c',
    `test ! -e '${privateFile}' && test ! -e '${historyFile}' && printf tampered > '${historyFile}' && test ! -e /proc/${process.pid}/environ && echo isolated`]);
  assert.match(output,/isolated/);
  assert.equal(readFileSync(historyFile,'utf8'),history,'protected execution must not modify private consumption history');
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
  await eventually(async () => (await json(statusPath)).executionReady);
  // Inject a real persistence outage in the disposable DB. All observations
  // remain at the public daemon/API seam, rather than reading stored records.
  const dbPort = readFileSync(join(home,'instances/acceptance/db/postmaster.pid'),'utf8').split('\n')[3];
  const sql = postgres(`postgres://paperclip:paperclip@127.0.0.1:${dbPort}/paperclip`,{max:1});
  try {
    await sql`ALTER TABLE plugin_state RENAME TO unavailable_plugin_state`;
    try {
      await eventually(async () => {assert.equal(daemon.exitCode,null,output); return output.includes('disconnected');});
    } finally { await sql`ALTER TABLE unavailable_plugin_state RENAME TO plugin_state`; }
    await eventually(async () => (await json(statusPath)).executionReady);
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
  await eventually(async () => (await json(statusPath)).executionReady);
  await json('/api/plugins/yelqo.outpost/disable',{});
  await eventually(async () => output.includes('disconnected'),20000);
  assert.equal(daemon.exitCode,null,output);
  await json('/api/plugins/yelqo.outpost/enable',{});
  await eventually(async () => (await json(statusPath)).executionReady,20000);
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
