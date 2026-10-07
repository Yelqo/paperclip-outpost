// Installed through Paperclip's public adapter API. This adapter exercises the
// execution-driver contract; assertions remain at public runs, logs and files.
export function createServerAdapter() {
  return {
    type:'process',runtimeToolDelivery:'environment',models:[],
    async execute({runId,config,executionTarget,onLog}) {
      const runner=executionTarget?.runner;
      if(!runner) throw new Error('A real environment execution driver is required');
      const execute=(operationId,purpose,command,timeoutMs=5000) => runner.execute({
        operationId,purpose,command:'/bin/sh',args:['-c',command],cwd:executionTarget.remoteCwd,timeoutMs,onLog,
      });
      if(config.scenario==='ownership') {
        let started,failed;
        const running=new Promise((resolve,reject) => { started=resolve; failed=reject; });
        const agent=runner.execute({
          operationId:`${runId}:agent`,purpose:'agent_execution',command:'/bin/sh',
          args:['-c','echo holding-workspace; echo agent >> launches; while ! test -e finish; do sleep .1; done'],
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
        : await execute(`${runId}:agent`,'agent_execution',config.args[1]);
      return {...result,resultJson:{stdout:result.stdout,stderr:result.stderr}};
    },
    async testEnvironment() { return {ok:true,checks:[]}; },
  };
}
