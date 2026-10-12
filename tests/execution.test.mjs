import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_RPC_ERROR_CODES } from '@paperclipai/plugin-sdk/protocol';
import { createExecutionWorkflows } from '../plugin/execution.ts';

function fixture({beforeStateSet}={}) {
  const scope={companyId:'company',config:{companyId:'company',outpostId:'outpost'},adapterType:'pi_local'};
  let online=true;
  const states=new Map();
  const logs=[];
  const execution=createExecutionWorkflows({execution:{log(stream,chunk){logs.push([stream,chunk]);}},state:{
    async get(input){return structuredClone(states.get(input.stateKey) ?? null);},
    async set(input,value){await beforeStateSet?.(input,value); states.set(input.stateKey,structuredClone(value));},
  }},()=>online);
  const drain=async () => (await execution.drain('company','outpost'))[0];
  const reply=(request,result,extra={}) => execution.message('company','outpost',{
    type:'result',requestId:request.requestId,runId:request.runId ?? '',operationId:request.operationId ?? '',result,...extra,
  });
  const admit=async runId => {
    const lease=await execution.acquire({...scope,runId});
    const realized=execution.realize({...scope,lease,workspace:{localPath:'/workspace'}});
    reply(await drain(),{cwd:'/workspace',workspaceId:'1:2',ownerRunId:''});
    await realized;
    return lease;
  };
  const execute=(lease,runId,operationId,purpose='control') => execution.execute({
    ...scope,lease,runId,operationId,purpose,cwd:'/workspace',command:'/bin/sh',timeoutMs:5000,
  });
  const release=lease => execution.release({...scope,providerLeaseId:lease.providerLeaseId});
  return {execution,logs,admit,execute,release,drain,reply,offline:()=>{online=false;},reconnect:()=>{online=true;}};
}

test('the first control stays retryable when the outpost goes offline after admission',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  f.offline();
  await assert.rejects(f.execute(lease,'A','probe'),{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE});
  assert.equal(await f.drain(),undefined,'an offline command must never be dispatched');
  await f.release(lease);
});

test('an explicit busy refusal of a setup control stays retryable',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','probe');
  const refused=assert.rejects(control,{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE});
  f.reply(await f.drain(),null,{error:'busy',errorCode:'execution_unavailable',beforeLaunch:true});
  await refused;
  await f.release(lease);
  await f.admit('B');
});

test('a refused control cannot schedule a replacement while an agent is still executing',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const agent=f.execute(lease,'A','agent','agent_execution');
  const request=await f.drain();
  f.offline();
  await assert.rejects(f.execute(lease,'A','control'),error => error.code!==PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE);
  f.reply(request,{exitCode:0,timedOut:false});
  await agent;
  await f.release(lease);
});

test('a refused control cannot schedule a replacement after an agent has executed',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const agent=f.execute(lease,'A','agent','agent_execution');
  f.reply(await f.drain(),{exitCode:0,timedOut:false});
  await agent;
  f.offline();
  await assert.rejects(f.execute(lease,'A','control'),error => error.code!==PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE);
  await f.release(lease);
});

test('a refused control cannot schedule a replacement while a prior control is uncertain',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_OUTCOME_UNCERTAIN,message:'durable outcome is uncertain'});
  f.reply(await f.drain(),{exitCode:0,timedOut:false,ownershipUncertain:true,error:'durable outcome is uncertain'});
  await rejected;
  f.offline();
  await assert.rejects(f.execute(lease,'A','probe'),error => error.code!==PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE);
  await f.release(lease);
});

test('a lost control reply preserves ownership after lease release',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_OUTCOME_UNCERTAIN,message:'Outpost operation outcome is uncertain'});
  await f.drain();
  f.execution.close('company','outpost');
  t.mock.timers.tick(15001);
  await rejected;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('agent completion cannot release an outstanding control',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();
  const lease=await f.admit('A');
  const agent=f.execute(lease,'A','agent','agent_execution');
  const agentRequest=await f.drain();
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/outcome is uncertain/);
  await f.drain();
  f.reply(agentRequest,{exitCode:0,timedOut:false});
  await agent;
  f.execution.close('company','outpost');
  t.mock.timers.tick(15001);
  await rejected;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('a known sibling outcome does not clear a control with uncertain durable termination',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/durable outcome is uncertain/);
  f.reply(await f.drain(),{exitCode:0,timedOut:false,ownershipUncertain:true,error:'durable outcome is uncertain'});
  await rejected;
  const agent=f.execute(lease,'A','agent','agent_execution');
  f.reply(await f.drain(),{exitCode:0,timedOut:false});
  await agent;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('a before-launch refusal clears only its own operation',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/durable outcome is uncertain/);
  f.reply(await f.drain(),{exitCode:0,timedOut:false,ownershipUncertain:true,error:'durable outcome is uncertain'});
  await rejected;
  const agent=f.execute(lease,'A','agent','agent_execution');
  const refused=assert.rejects(agent,/busy/);
  f.reply(await f.drain(),null,{error:'busy',errorCode:'execution_unavailable',beforeLaunch:true});
  await refused;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('controls cancelled before dispatch do not retain workspace ownership',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/before launch/);
  f.execution.close('company','outpost');
  await rejected;
  await f.release(lease);
  await f.admit('B');
});

test('unresolved cancellation does not starve sibling operations or other runs',async () => {
  const f=fixture();
  const scope={companyId:'company',config:{companyId:'company',outpostId:'outpost'}};
  const deadline=new Date(Date.now()+60000).toISOString();
  const records=[
    {runId:'A',operationId:'missing',purpose:'agent_execution',workspace:'1:2',deadline,status:'uncertain',historyMissing:true},
    {runId:'B',operationId:'agent',purpose:'agent_execution',workspace:'2:3',deadline,status:'running'},
    {runId:'B',operationId:'control',purpose:'control',workspace:'2:3',deadline,status:'running'},
  ];
  for(const record of records) await f.execution.history.prepare('company','outpost',record);
  await f.execution.cancelRun({...scope,runId:'A'});
  await f.execution.cancelRun({...scope,runId:'B'});
  const delivered=new Set();
  for(let i=0;i<records.length;i++) {
    const request=await f.drain();
    assert.equal(request.type,'cancel');
    delivered.add(request.operationId);
  }
  assert.deepEqual(delivered,new Set(['missing','agent','control']));
  await f.execution.history.report('company','outpost',{
    ...records[1],status:'terminal',outcome:{exitCode:null,timedOut:false,cancelled:true},
  });
  const retried=new Set();
  for(let i=0;i<records.length;i++) retried.add((await f.drain()).operationId);
  assert.deepEqual(retried,new Set(['missing','control']),'only unresolved cancellations need redelivery');
  assert.equal((await f.execution.cancelRun({...scope,runId:'A',queryOnly:true})).state,'requested');
  assert.equal((await f.execution.cancelRun({...scope,runId:'B',queryOnly:true})).state,'requested');
});

test('unresolved cancellation permits unrelated dispatch while retaining its workspace fence',async t => {
  const f=fixture();
  const scope={companyId:'company',config:{companyId:'company',outpostId:'outpost'},adapterType:'process'};
  const record={runId:'A',operationId:'missing',purpose:'agent_execution',workspace:'1:2',
    deadline:new Date(Date.now()+60000).toISOString(),status:'uncertain',historyMissing:true};
  await f.execution.history.prepare('company','outpost',record);
  f.execution.restore('company','outpost',[record]);
  await f.execution.cancelRun({...scope,runId:'A'});
  t.after(()=>f.execution.close('company','outpost'));
  const lease=await f.execution.acquire({...scope,runId:'B'});
  const realized=f.execution.realize({...scope,lease,workspace:{localPath:'/other'}});
  realized.catch(()=>{});
  const poll=await f.execution.drain('company','outpost');
  assert.ok(poll.some(request=>request.type==='cancel' && request.operationId==='missing'));
  const inspection=poll.find(request=>request.type==='inspect');
  assert.ok(inspection,'unrelated workspace inspection must share the delivery lane');
  await f.reply(inspection,{cwd:'/other',workspaceId:'2:3',ownerRunId:''});
  await realized;
  const running=f.execution.execute({...scope,lease,runId:'B',operationId:'unrelated',purpose:'agent_execution',
    cwd:'/other',command:'/bin/true',timeoutMs:5000});
  running.catch(()=>{});
  const dispatch=(await f.execution.drain('company','outpost')).find(request=>request.type==='execute');
  assert.ok(dispatch,'unrelated execution must be delivered despite unresolved cancellation');
  await f.reply(dispatch,{exitCode:0,timedOut:false});
  assert.equal((await running).exitCode,0);
  await f.release(lease);
  const conflictingLease=await f.execution.acquire({...scope,runId:'C'});
  const conflicting=f.execution.realize({...scope,lease:conflictingLease,workspace:{localPath:'/workspace'}});
  const rejected=assert.rejects(conflicting,/busy|uncertain/);
  const conflictInspection=(await f.execution.drain('company','outpost')).find(request=>request.type==='inspect');
  assert.ok(conflictInspection);
  await f.reply(conflictInspection,{cwd:'/workspace',workspaceId:'1:2',ownerRunId:''});
  await rejected;
  await f.release(conflictingLease);
  assert.equal((await f.execution.cancelRun({...scope,runId:'A',queryOnly:true})).state,'requested');
});

test('lease release waits for every control to settle and then frees the workspace',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const first=f.execute(lease,'A','first');
  const firstRequest=await f.drain();
  const second=f.execute(lease,'A','second');
  const secondRequest=await f.drain();
  await f.release(lease);
  f.reply(firstRequest,{exitCode:0,timedOut:false});
  await first;
  await assert.rejects(f.admit('B'),/busy|uncertain/);
  f.reply(secondRequest,{exitCode:0,timedOut:false});
  await second;
  await f.admit('C');
});

test('a dispatched operation survives reconnection and a lost output acknowledgement',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const running=f.execute(lease,'A','agent','agent_execution');
  const request=await f.drain();
  const output={type:'output',requestId:request.requestId,runId:'A',operationId:'agent',sequence:1,stream:'stdout',data:Buffer.from('structured-output\n').toString('base64')};
  await f.execution.message('company','outpost',output);
  f.execution.close('company','outpost');
  await f.execution.message('company','outpost',output);
  f.reply(request,{exitCode:0,timedOut:false});
  const result=await running;
  assert.equal(result.stdout,'structured-output\n');
  assert.deepEqual(f.logs,[['stdout','structured-output\n']]);
});

test('overlapping output redelivery after reconnect preserves the durable cursor and emits each chunk once',async t => {
  let resume,entered,paused=false;
  const gate=new Promise(resolve=>{resume=resolve;});
  const writing=new Promise(resolve=>{entered=resolve;});
  const f=fixture({async beforeStateSet(input,value) {
    if(input.stateKey.endsWith(':cursor') && value.sequence===1 && !paused) {
      paused=true; entered(); await gate;
    }
  }});
  const lease=await f.admit('A');
  const running=f.execute(lease,'A','agent','agent_execution');
  const request=await f.drain();
  t.after(async ()=>{resume(); await f.reply(request,{exitCode:0,timedOut:false});});
  const frame=(sequence,data)=>({type:'output',requestId:request.requestId,runId:'A',operationId:'agent',sequence,stream:'stdout',data:Buffer.from(data).toString('base64')});
  const original=f.execution.message('company','outpost',frame(1,'first'));
  await writing;
  f.execution.close('company','outpost');
  const replay=f.execution.message('company','outpost',frame(1,'first'));
  // The old connection's delayed storage write overlaps the new connection.
  // Release it after any unblocked replay and subsequent write have run.
  setImmediate(resume);
  await replay;
  await f.execution.message('company','outpost',frame(2,'second'));
  await original;
  await f.execution.message('company','outpost',frame(3,'third'));
  await f.reply(request,{exitCode:0,timedOut:false});
  assert.equal((await running).stdout,'firstsecondthird');
  assert.deepEqual(f.logs,[['stdout','first'],['stdout','second'],['stdout','third']]);
  const retained=await f.execution.output.read('company','outpost','agent',0);
  assert.equal(retained.receipt.sequence,3);
  assert.equal(retained.receipt.bytes,16);
});

test('a recovered spool-reservation failure remains nonretryable',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const running=f.execute(lease,'A','agent','agent_execution');
  const rejected=assert.rejects(running,{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_OUTPUT_LIMIT,message:'output limit exceeded'});
  const request=await f.drain();
  f.execution.close('company','outpost');
  const record={runId:'A',operationId:'agent',purpose:'agent_execution',workspace:'1:2',deadline:request.deadline,
    status:'terminal',outcome:{exitCode:null,timedOut:false,error:'output limit exceeded'}};
  await f.execution.history.report('company','outpost',record);
  await f.execution.reconcile('company','outpost',record);
  await f.reply(request,record.outcome);
  await rejected;
  await f.release(lease);
  assert.deepEqual(f.logs,[]);
  assert.equal((await f.execution.history.all('company','outpost'))[0].outcome.error,'output limit exceeded');
});

test('exhaustion recovered after the grace period cannot make the original failure retryable',async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();
  const lease=await f.admit('A');
  const running=f.execute(lease,'A','agent','agent_execution');
  const rejected=assert.rejects(running,{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_OUTCOME_UNCERTAIN,message:'Outpost operation outcome is uncertain'});
  const request=await f.drain();
  f.offline();
  f.execution.close('company','outpost');
  t.mock.timers.tick(15001);
  await rejected;
  await f.release(lease);
  f.reconnect();
  await assert.rejects(f.admit('B'),/busy|uncertain/);
  const record={runId:'A',operationId:'agent',purpose:'agent_execution',workspace:'1:2',deadline:request.deadline,
    status:'terminal',outcome:{exitCode:null,timedOut:false,error:'output limit exceeded'}};
  await f.execution.history.report('company','outpost',record);
  await f.execution.reconcile('company','outpost',record);
  await f.reply(request,record.outcome);
  assert.equal((await f.execution.history.all('company','outpost'))[0].outcome.error,'output limit exceeded');
  assert.deepEqual(f.logs,[]);
  // The recovered terminal result frees the directory for an explicit new run.
  // It must never change the original failure into a retryable adapter failure.
  await f.admit('operator-continuation');
});
