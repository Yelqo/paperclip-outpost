import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionWorkflows } from '../plugin/execution.ts';

function fixture() {
  const scope={companyId:'company',config:{companyId:'company',outpostId:'outpost'},adapterType:'pi_local'};
  const execution=createExecutionWorkflows({execution:{log(){}}},()=>true);
  const drain=() => execution.drain('company','outpost')[0];
  const reply=(request,result,extra={}) => execution.message('company','outpost',{
    type:'result',requestId:request.requestId,runId:request.runId ?? '',operationId:request.operationId ?? '',result,...extra,
  });
  const admit=async runId => {
    const lease=await execution.acquire({...scope,runId});
    const realized=execution.realize({...scope,lease,workspace:{localPath:'/workspace'}});
    reply(drain(),{cwd:'/workspace',workspaceId:'1:2',ownerRunId:''});
    await realized;
    return lease;
  };
  const execute=(lease,runId,operationId,purpose='control') => execution.execute({
    ...scope,lease,runId,operationId,purpose,cwd:'/workspace',command:'/bin/sh',timeoutMs:5000,
  });
  const release=lease => execution.release({...scope,providerLeaseId:lease.providerLeaseId});
  return {execution,admit,execute,release,drain,reply};
}

test('a lost control reply preserves ownership after lease release',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/outcome is uncertain/);
  f.drain();
  f.execution.close('company','outpost');
  await rejected;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('agent completion cannot release an outstanding control',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const agent=f.execute(lease,'A','agent','agent_execution');
  const agentRequest=f.drain();
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/outcome is uncertain/);
  f.drain();
  f.reply(agentRequest,{exitCode:0,timedOut:false});
  await agent;
  f.execution.close('company','outpost');
  await rejected;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('a known sibling outcome does not clear a control with uncertain durable termination',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/durable outcome is uncertain/);
  f.reply(f.drain(),{exitCode:0,timedOut:false,ownershipUncertain:true,error:'durable outcome is uncertain'});
  await rejected;
  const agent=f.execute(lease,'A','agent','agent_execution');
  f.reply(f.drain(),{exitCode:0,timedOut:false});
  await agent;
  await f.release(lease);
  await assert.rejects(f.admit('B'),/busy|uncertain/);
});

test('a before-launch refusal clears only its own operation',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const control=f.execute(lease,'A','control');
  const rejected=assert.rejects(control,/durable outcome is uncertain/);
  f.reply(f.drain(),{exitCode:0,timedOut:false,ownershipUncertain:true,error:'durable outcome is uncertain'});
  await rejected;
  const agent=f.execute(lease,'A','agent','agent_execution');
  const refused=assert.rejects(agent,/busy/);
  f.reply(f.drain(),null,{error:'busy',errorCode:'execution_unavailable',beforeLaunch:true});
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

test('lease release waits for every control to settle and then frees the workspace',async () => {
  const f=fixture();
  const lease=await f.admit('A');
  const first=f.execute(lease,'A','first');
  const firstRequest=f.drain();
  const second=f.execute(lease,'A','second');
  const secondRequest=f.drain();
  await f.release(lease);
  f.reply(firstRequest,{exitCode:0,timedOut:false});
  await first;
  await assert.rejects(f.admit('B'),/busy|uncertain/);
  f.reply(secondRequest,{exitCode:0,timedOut:false});
  await second;
  await f.admit('C');
});
