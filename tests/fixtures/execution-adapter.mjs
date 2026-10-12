// Installed through Paperclip's public adapter API. This adapter exercises the
// execution-driver contract; assertions remain at public runs, logs and files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function createServerAdapter(adapterType='process') {
  return {
    type:adapterType,runtimeToolDelivery:'environment',models:[],
    async execute({runId,config,executionTarget,onLog}) {
      const runner=executionTarget?.runner;
      if(!runner) throw new Error('A real environment execution driver is required');
      const execute=(operationId,purpose,command,timeoutMs=5000) => runner.execute({
        operationId,purpose,command:'/bin/sh',args:['-c',command],cwd:executionTarget.remoteCwd,timeoutMs,onLog,
      });
      if(config.scenario==='drain-after-agent') {
        const result=await execute(`${runId}:agent`,'agent_execution','echo agent >> launches');
        await onLog('stdout','awaiting-associated-control\n');
        const deadline=Date.now()+30000;
        while(!existsSync(join(executionTarget.remoteCwd,'start-control'))) {
          if(Date.now()>deadline) throw new Error('Timed out waiting for associated control');
          await delay(100);
        }
        const control=await execute(`${runId}:control`,'control','echo control > control');
        if(control.exitCode!==0) throw new Error('Associated control failed');
        return {...result,resultJson:{controlSucceeded:true}};
      }
      if(config.scenario==='control-ownership') {
        const result=await execute(`${runId}:control`,'control',
          'echo control-started > control; printf before-restart; while ! test -e finish-control; do sleep .1; done; printf after-restart; echo control-finished > finished-control',60000);
        return {...result,resultJson:{controlSucceeded:true}};
      }
      if(config.scenario==='ownership' || config.scenario==='drain') {
        let started,failed;
        const running=new Promise((resolve,reject) => { started=resolve; failed=reject; });
        const agent=runner.execute({
          operationId:`${runId}:agent`,purpose:'agent_execution',command:'/bin/sh',
          args:['-c',`${config.scenario==='drain' ? 'echo started > started; while ! test -e start-control; do sleep .1; done;' : ''} echo holding-workspace; echo agent >> launches; while ! test -e finish; do sleep .1; done`],
          cwd:executionTarget.remoteCwd,timeoutMs:30000,
          onLog:async (stream,chunk) => { await onLog(stream,chunk); if(chunk.includes('holding-workspace')) started(); },
        });
        // Observe launch errors immediately while waiting for streaming output.
        agent.catch(failed);
        await running;
        const [result,control]=await Promise.all([agent,execute(`${runId}:control`,'control','echo control > control; while ! test -e allow-finish; do sleep .1; done; touch finish',30000)]);
        if(control.exitCode!==0) throw new Error('Associated control failed');
        return {...result,resultJson:{controlSucceeded:true}};
      }
      const result=config.scenario==='replay'
        ? await execute('acceptance:stable-operation','agent_execution','echo effect >> launches; echo stable-output')
        : await execute(`${runId}:agent`,'agent_execution',config.args[1],(config.timeoutSec ?? 5)*1000);
      return {...result,resultJson:{stdout:result.stdout,stderr:result.stderr}};
    },
    async testEnvironment() { return {ok:true,checks:[]}; },
  };
}
