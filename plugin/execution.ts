import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk/protocol";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginEnvironmentAcquireLeaseParams, PluginEnvironmentExecuteParams, PluginEnvironmentRealizeWorkspaceParams, PluginEnvironmentReleaseLeaseParams } from "@paperclipai/plugin-sdk/protocol";

type CallbackTransport = NonNullable<PluginEnvironmentExecuteParams["callbackTransport"]>;
type Identity = { runId:string; operationId:string; purpose:"agent_execution"|"control" };
type OperationRequest =
  | {type:"inspect";cwd:string;deadline:string}
  | Identity & {type:"execute";workspaceId:string;command:string;args?:string[];cwd:string;env?:Record<string,string>;callbackTransport?:CallbackTransport;stdin?:string;deadline:string};
type Inspection = {cwd:string;workspaceId:string;ownerRunId:string};
type Outcome = {exitCode:number|null;signal?:string;timedOut:boolean;error?:string;ownershipUncertain?:boolean};
type OutputFrame = {type:"output";requestId:string;runId:string;operationId:string;stream:"stdout"|"stderr";data:string};
type ResultFrame = {type:"result";requestId:string;runId:string;operationId:string;result:unknown;error?:string;errorCode?:"execution_unavailable";beforeLaunch?:boolean};
type Frame = OutputFrame | ResultFrame;
type Pending = {
  outpostId:string; companyId:string; identity?:Identity;
  sent:boolean;
  onSent?:() => void;
  deliver:(frame:Frame) => void;
  reject:(error:Error) => void;
};

function unavailable(message:string):Error {
  return Object.assign(new Error(message),{code:PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE});
}

function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("Invalid Outpost response");
  return value as Record<string,unknown>;
}
function readFrame(value:unknown):Frame {
  const frame=object(value);
  if(typeof frame.requestId!=="string" || typeof frame.runId!=="string" || typeof frame.operationId!=="string") throw new Error("Invalid response identity");
  const identity={requestId:frame.requestId,runId:frame.runId,operationId:frame.operationId};
  if(frame.type==="output" && (frame.stream==="stdout" || frame.stream==="stderr") && typeof frame.data==="string") return {...identity,type:"output",stream:frame.stream,data:frame.data};
  if(frame.type==="result" && (frame.error===undefined || typeof frame.error==="string") && (frame.errorCode===undefined || frame.errorCode==="execution_unavailable") && (frame.beforeLaunch===undefined || typeof frame.beforeLaunch==="boolean")) return {...identity,type:"result",result:frame.result,error:frame.error,errorCode:frame.errorCode,beforeLaunch:frame.beforeLaunch};
  throw new Error("Invalid Outpost response frame");
}
function readInspection(value:unknown):Inspection {
  const result=object(value);
  if(typeof result.cwd!=="string" || !result.cwd.startsWith("/") || typeof result.workspaceId!=="string" || !/^\d+:\d+$/.test(result.workspaceId) || typeof result.ownerRunId!=="string") throw new Error("Invalid workspace result");
  return {cwd:result.cwd,workspaceId:result.workspaceId,ownerRunId:result.ownerRunId};
}
function readOutcome(value:unknown):Outcome {
  const result=object(value);
  if((result.exitCode!==null && (!Number.isInteger(result.exitCode) || typeof result.exitCode!=="number")) || typeof result.timedOut!=="boolean" ||
    (result.signal!==undefined && typeof result.signal!=="string") || (result.error!==undefined && typeof result.error!=="string") || (result.ownershipUncertain!==undefined && typeof result.ownershipUncertain!=="boolean")) throw new Error("Invalid process outcome");
  return {exitCode:result.exitCode as number|null,timedOut:result.timedOut,signal:result.signal as string|undefined,error:result.error as string|undefined,ownershipUncertain:result.ownershipUncertain as boolean|undefined};
}

/** Commands enter through Paperclip's driver; the transport only delivers them.
 * No transport redelivery or lease reuse creates a new execution identity. */
export function createExecutionWorkflows(ctx:PluginContext, online:(companyId:string,outpostId:string) => boolean) {
  const pending = new Map<string,Pending>();
  const queues = new Map<string,Array<OperationRequest & {requestId:string}>>();
  type Lease = {runId:string;outpostKey:string;workspaceId?:string;workspaceKey?:string;operations:Map<string,Identity["purpose"]>;released:boolean;executedAgent:boolean};
  const leases = new Map<string,Lease>();
  const owners = new Map<string,string>();
  const key = (companyId:string,outpostId:string) => `${companyId}:${outpostId}`;
  const dispatch = <A>(companyId:string,outpostId:string,request:OperationRequest,readResult:(value:unknown)=>A,onOutput?:(frame:OutputFrame)=>void,onSent?:()=>void):Promise<A> => {
    if (!online(companyId,outpostId)) return Promise.reject(unavailable("Outpost is offline"));
    const role=request.type==="inspect" ? undefined : request.purpose;
    const rolePending=[...pending.values()].filter(value => value.companyId===companyId && value.outpostId===outpostId && value.identity?.purpose===role).length;
    if (rolePending >= 16) return Promise.reject(unavailable("Outpost admission capacity reached"));
    const requestId = randomUUID();
    const queued={...request,requestId};
    const serialized = JSON.stringify(queued);
    if (Buffer.byteLength(serialized)>12000) return Promise.reject(new Error("Outpost command exceeds the transport limit"));
    return new Promise((resolve,reject) => {
      const dispose = () => { clearTimeout(timer); pending.delete(requestId); const queue=queues.get(key(companyId,outpostId)); if(queue) queues.set(key(companyId,outpostId),queue.filter(value => value.requestId !== requestId)); };
      const timer = setTimeout(() => {
        const sent=pending.get(requestId)?.sent && request.type==="execute";
        dispose(); reject(sent ? new Error("Outpost operation outcome is uncertain") : unavailable("Outpost unavailable before dispatch"));
      },Math.max(10000,Date.parse(request.deadline)-Date.now()+10000));
      pending.set(requestId,{
        outpostId,companyId,sent:false,onSent,identity:request.type==="execute" ? request : undefined,
        deliver(frame) {
          if (frame.type === "output") { onOutput?.(frame); return; }
          dispose();
          if (typeof frame.error === "string") reject(Object.assign(frame.errorCode==="execution_unavailable" ? unavailable(frame.error) : new Error(frame.error),{beforeLaunch:frame.beforeLaunch}));
          else {
            try { resolve(readResult(frame.result)); }
            catch(error) { reject(error); }
          }
        },
        reject(error) { dispose(); reject(error); },
      });
      const queue = queues.get(key(companyId,outpostId)) ?? [];
      queue.push(queued); queues.set(key(companyId,outpostId),queue);
    });
  };
  const drain = (companyId:string,outpostId:string) => {
    const queue=queues.get(key(companyId,outpostId));
    const message=queue?.shift();
    const request=message && pending.get(message.requestId);
    if(request) { request.sent=true; request.onSent?.(); }
    return message ? [message] : [];
  };
  const message = (companyId:string,outpostId:string,value:unknown) => {
    const frame=readFrame(value);
    const request=pending.get(frame.requestId);
    if (!request || request.companyId !== companyId || request.outpostId !== outpostId) return;
    if (request.identity && (frame.runId !== request.identity.runId || frame.operationId !== request.identity.operationId)) throw new Error("Mismatched execution identity");
    request.deliver(frame);
  };
  const close = (companyId:string,outpostId:string) => {
    for (const request of [...pending.values()]) if (request.companyId===companyId && request.outpostId===outpostId) request.reject(request.sent && request.identity ? new Error("Outpost disconnected; operation outcome is uncertain") : unavailable("Outpost disconnected before launch"));
    queues.delete(key(companyId,outpostId));
  };
  const outpost = (input:{companyId:string;config:Record<string,unknown>}) => {
    if (input.config.companyId!==input.companyId || typeof input.config.outpostId!=="string") throw new Error("Outpost company scope mismatch");
    return input.config.outpostId;
  };
  const acquire = async (input:PluginEnvironmentAcquireLeaseParams) => {
    const id=outpost(input);
    if (!online(input.companyId,id)) throw unavailable("Outpost is offline");
    if (!input.runId) throw new Error("An explicit run is required");
    if (!["process","pi_local"].includes(input.adapterType ?? "")) throw new Error("This Outpost release supports process and pi_local adapters");
    const providerLeaseId=randomUUID();
    leases.set(providerLeaseId,{runId:input.runId,outpostKey:key(input.companyId,id),operations:new Map(),released:false,executedAgent:false});
    return {providerLeaseId};
  };
  const leaseFor = (input:PluginEnvironmentRealizeWorkspaceParams | PluginEnvironmentExecuteParams) => {
    const lease=leases.get(input.lease.providerLeaseId ?? "");
    if(!lease || lease.outpostKey!==key(input.companyId,outpost(input))) throw new Error("Unknown Outpost run lease");
    return lease;
  };
  const releaseOwnership = (lease:Lease) => {
    if(lease.released && lease.operations.size===0 && lease.workspaceKey && owners.get(lease.workspaceKey)===lease.runId) owners.delete(lease.workspaceKey);
  };
  const release = async (input:PluginEnvironmentReleaseLeaseParams) => {
    const id=input.providerLeaseId ?? "";
    const lease=leases.get(id);
    if(!lease || lease.outpostKey!==key(input.companyId,outpost(input))) return;
    lease.released=true;
    releaseOwnership(lease);
    leases.delete(id);
  };
  const realize = async (input:PluginEnvironmentRealizeWorkspaceParams) => {
    const lease=leaseFor(input);
    const cwd=input.workspace.remotePath ?? input.workspace.localPath;
    if (!cwd?.startsWith("/")) throw new Error("An existing absolute workspace path is required");
    const result=await dispatch(input.companyId,outpost(input),{type:"inspect",cwd,deadline:new Date(Date.now()+10000).toISOString()},readInspection);
    const workspaceKey=`${lease.outpostKey}:${result.workspaceId}`;
    if([owners.get(workspaceKey),result.ownerRunId].some(owner => owner && owner!==lease.runId)) throw unavailable("Outpost workspace is busy or its previous process outcome is uncertain");
    lease.workspaceId=result.workspaceId; lease.workspaceKey=workspaceKey;
    owners.set(workspaceKey,lease.runId);
    return {cwd:result.cwd,metadata:{mode:"in_place",remoteCwd:result.cwd,workspaceRealization:{mode:"in_place",authoritativeRoot:result.cwd,pathAliases:[],outboundRestorePaths:[]}}};
  };
  const execute = async (input:PluginEnvironmentExecuteParams) => {
    if (!input.runId || !input.operationId || (input.purpose!=="agent_execution" && input.purpose!=="control")) throw new Error("Paperclip must author execution identity and purpose");
    if(!input.cwd?.startsWith("/")) throw new Error("An existing absolute workspace path is required");
    const lease=leaseFor(input);
    if(lease.runId!==input.runId || !lease.workspaceId || !lease.workspaceKey) throw new Error("Execution requires the run's admitted workspace");
    if(owners.get(lease.workspaceKey)!==input.runId) throw new Error("Execution workspace ownership changed");
    const timeout=Math.min(input.timeoutMs && input.timeoutMs>0 ? input.timeoutMs : 60000,3600000);
    let stdout="",stderr="";
    const decoders={stdout:new StringDecoder("utf8"),stderr:new StringDecoder("utf8")};
    const log=AsyncLocalStorage.bind((stream:"stdout"|"stderr",chunk:string) => ctx.execution.log(stream,chunk));
    const agentExecution=input.purpose==="agent_execution";
    const operationId=input.operationId;
    if(lease.operations.has(operationId)) throw new Error("The run's previous operation still owns the workspace");
    if(agentExecution && [...lease.operations.values()].includes("agent_execution")) throw new Error("The run's previous agent operation still owns the workspace");
    lease.operations.set(operationId,input.purpose);
    const settle = () => { lease.operations.delete(operationId); releaseOwnership(lease); };
    let sent=false;
    let result:Outcome;
    try { result = await dispatch(input.companyId,outpost(input),{
      type:"execute",runId:input.runId,operationId:input.operationId,purpose:input.purpose,
      workspaceId:lease.workspaceId,
      command:input.command,args:input.args,cwd:input.cwd,env:input.env,callbackTransport:input.callbackTransport,stdin:input.stdin,
      deadline:new Date(Date.now()+timeout).toISOString(),
    },readOutcome,frame => {
      const chunk=decoders[frame.stream].write(Buffer.from(frame.data,"base64"));
      if(frame.stream==="stdout") stdout+=chunk; else stderr+=chunk;
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>1048576) throw new Error("Outpost output limit exceeded");
      log(frame.stream,chunk);
    },() => { sent=true; }); } catch(error) {
      if(!sent || (error instanceof Error && "beforeLaunch" in error && error.beforeLaunch===true)) settle();
      if(error instanceof Error && "code" in error && error.code===PLUGIN_RPC_ERROR_CODES.EXECUTION_UNAVAILABLE) {
        settle();
        // Setup controls can defer too, but an outstanding operation or an
        // already executed agent makes a replacement run unsafe.
        if(lease.executedAgent || lease.operations.size>0) throw new Error(error.message);
      }
      throw error;
    }
    if(agentExecution) lease.executedAgent=true;
    if(result.ownershipUncertain!==true) settle();
    for (const stream of ["stdout","stderr"] as const) {
      const chunk=decoders[stream].end();
      if(stream==="stdout") stdout+=chunk; else stderr+=chunk;
      if(chunk) log(stream,chunk);
    }
    if (result.error) throw new Error(result.error);
    return {...result,stdout,stderr};
  };
  return {acquire,realize,execute,release,drain,message,close};
}
