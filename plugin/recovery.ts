import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createHash } from "node:crypto";

export type Outcome = {exitCode:number|null;signal?:string;timedOut:boolean;error?:string;ownershipUncertain?:boolean;interrupted?:boolean};
export type ExecutionRecord = {
  runId:string; operationId:string; purpose:"agent_execution"|"control"; workspace:string; deadline:string;
  bootId?:string; processId?:number; processStart?:string; historyMissing?:boolean; refused?:boolean;
  status:"running"|"uncertain"|"terminal"|"interrupted"; outcome?:Outcome;
};

// A shared canonical tuple keeps Go/TypeScript fingerprints independent of
// JSON property order and omitted zero values. A mismatch still exchanges the
// authoritative record; a fingerprint never supplies permission to launch.
export function recordDigest(record:ExecutionRecord):string {
  const outcome=record.outcome;
  const tuple=[record.runId,record.operationId,record.purpose,record.workspace,record.deadline,record.bootId ?? "",record.processId ?? 0,
    record.processStart ?? "",record.historyMissing ?? false,record.refused ?? false,record.status,
    outcome ? [outcome.exitCode,outcome.signal ?? "",outcome.timedOut,outcome.error ?? "",outcome.ownershipUncertain ?? false,outcome.interrupted ?? false] : null];
  const serialized=JSON.stringify(tuple).replace(/[<>&\u2028\u2029]/g,value=>"\\u"+value.charCodeAt(0).toString(16).padStart(4,"0"));
  return createHash("sha256").update(serialized).digest("hex");
}

function object(value:unknown):Record<string,unknown> {
  if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("Invalid execution history");
  return value as Record<string,unknown>;
}

export function readOutcome(value:unknown):Outcome {
  const result=object(value);
  if((result.exitCode!==null && (!Number.isInteger(result.exitCode) || typeof result.exitCode!=="number")) || typeof result.timedOut!=="boolean" ||
    (result.signal!==undefined && typeof result.signal!=="string") || (result.error!==undefined && typeof result.error!=="string") ||
    (result.ownershipUncertain!==undefined && typeof result.ownershipUncertain!=="boolean") || (result.interrupted!==undefined && typeof result.interrupted!=="boolean")) throw new Error("Invalid process outcome");
  return {exitCode:result.exitCode as number|null,timedOut:result.timedOut,signal:result.signal as string|undefined,error:result.error as string|undefined,
    ownershipUncertain:result.ownershipUncertain as boolean|undefined,interrupted:result.interrupted as boolean|undefined};
}

export function readExecutionRecord(value:unknown):ExecutionRecord {
  const record=object(value);
  if(typeof record.runId!=="string" || !record.runId || typeof record.operationId!=="string" || !record.operationId ||
    (record.purpose!=="agent_execution" && record.purpose!=="control") || typeof record.workspace!=="string" || !/^\d+:\d+$/.test(record.workspace) ||
    typeof record.deadline!=="string" || !Number.isFinite(Date.parse(record.deadline)) ||
    !["running","uncertain","terminal","interrupted"].includes(record.status as string) ||
    (record.bootId!==undefined && typeof record.bootId!=="string") || (record.processId!==undefined && (!Number.isInteger(record.processId) || (record.processId as number)<=0)) ||
    (record.processStart!==undefined && typeof record.processStart!=="string") || (record.historyMissing!==undefined && typeof record.historyMissing!=="boolean") ||
    (record.refused!==undefined && typeof record.refused!=="boolean")) throw new Error("Invalid execution history identity");
  const outcome=record.outcome===undefined ? undefined : readOutcome(record.outcome);
  if((record.status==="terminal" || record.status==="interrupted") !== (outcome!==undefined && !outcome.ownershipUncertain)) throw new Error("Invalid execution history status");
  if((record.status==="interrupted") !== (outcome?.interrupted===true) || (record.historyMissing===true && record.status!=="uncertain")) throw new Error("Invalid recovery outcome");
  return {runId:record.runId,operationId:record.operationId,purpose:record.purpose,workspace:record.workspace,deadline:record.deadline,
    status:record.status as ExecutionRecord["status"],outcome,bootId:record.bootId as string|undefined,processId:record.processId as number|undefined,
    processStart:record.processStart as string|undefined,historyMissing:record.historyMissing as boolean|undefined,refused:record.refused as boolean|undefined};
}

/** The instance's durable delivery witness is independent of VM snapshots.
 * Serial writes per outpost prevent concurrent operations losing consumption. */
export function createRecoveryHistory(ctx:PluginContext) {
  const writes=new Map<string,Promise<unknown>>();
  const scope=(companyId:string,outpostId:string) => ({scopeKind:"company" as const,scopeId:companyId,stateKey:`outpost-history:${outpostId}`});
  const all=async (companyId:string,outpostId:string):Promise<ExecutionRecord[]> => {
    const value=await ctx.state.get(scope(companyId,outpostId));
    if(value===null) return [];
    if(!Array.isArray(value)) throw new Error("Execution history witness is unavailable");
    return value.map(readExecutionRecord);
  };
  const update=<A>(companyId:string,outpostId:string,change:(records:ExecutionRecord[])=>A) => {
    const key=`${companyId}:${outpostId}`;
    const previous=writes.get(key) ?? Promise.resolve();
    const next=previous.catch(()=>{}).then(async () => {
      const records=await all(companyId,outpostId);
      const result=change(records);
      await ctx.state.set(scope(companyId,outpostId),records);
      return result;
    });
    writes.set(key,next);
    void next.finally(()=>{if(writes.get(key)===next) writes.delete(key);}).catch(()=>{});
    return next;
  };
  const prepare=(companyId:string,outpostId:string,record:ExecutionRecord) => update(companyId,outpostId,records => {
    if(records.some(value=>value.operationId===record.operationId)) throw new Error("operation was already admitted; it will not launch again");
    records.push(record);
  });
  const report=(companyId:string,outpostId:string,record:ExecutionRecord) => update(companyId,outpostId,records => {
    const index=records.findIndex(value=>value.operationId===record.operationId);
    const prior=records[index];
    if(prior && (prior.runId!==record.runId || prior.purpose!==record.purpose || prior.workspace!==record.workspace || prior.deadline!==record.deadline)) throw new Error("Conflicting execution history identity");
    // A stale live report cannot erase a terminal result or missing-history fence.
    if(prior?.historyMissing && !record.historyMissing) return prior;
    if(prior?.outcome && !record.outcome && !record.historyMissing) return prior;
    if(index<0) records.push(record); else records[index]=record;
    return record;
  });
  const refuse=(companyId:string,outpostId:string,operationId:string,runId:string) => update(companyId,outpostId,records => {
    const record=records.find(value=>value.operationId===operationId);
    if(!record || record.runId!==runId || record.outcome || record.historyMissing) throw new Error("Invalid before-launch receipt");
    record.refused=true;
    record.status="terminal";
    record.outcome={exitCode:null,timedOut:false,error:"execution refused before launch"};
  });
  return {all,prepare,report,refuse};
}
