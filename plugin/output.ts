import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export type OutputFrame = {type:"output";requestId:string;runId:string;operationId:string;sequence:number;stream:"stdout"|"stderr";data:string};
type Cursor = {runId:string;operationId:string;sequence:number;bytes:number};

/** Acknowledgements mean the instance durably owns the bytes. A chunk and its
 * cursor are stored separately so each SDK write remains below the frame bound.
 * Repeating a chunk after a lost ack repairs a missing cursor without duplication. */
export function createOutputHistory(ctx:PluginContext) {
  const scope=(companyId:string,outpostId:string,operationId:string,suffix:string) => ({scopeKind:"company" as const,scopeId:companyId,
    stateKey:`outpost-output:${outpostId}:${createHash("sha256").update(operationId).digest("hex")}:${suffix}`});
  const cursor=async (companyId:string,outpostId:string,operationId:string):Promise<Cursor|null> =>
    await ctx.state.get(scope(companyId,outpostId,operationId,"cursor")) as Cursor|null;
  const accept=async (companyId:string,outpostId:string,frame:OutputFrame) => {
    const prior=await cursor(companyId,outpostId,frame.operationId);
    if(prior && prior.runId!==frame.runId) throw new Error("Mismatched output identity");
    const bytes=Buffer.from(frame.data,"base64");
    if(bytes.length===0 || bytes.length>2048 || bytes.toString("base64")!==frame.data) throw new Error("Invalid output bytes");
    const chunkScope=scope(companyId,outpostId,frame.operationId,String(frame.sequence));
    const chunk={sequence:frame.sequence,stream:frame.stream,data:frame.data};
    if(frame.sequence<=(prior?.sequence ?? 0)) {
      const stored=await ctx.state.get(chunkScope) as typeof chunk|null;
      if(!stored || stored.stream!==chunk.stream || stored.data!==chunk.data) throw new Error("Conflicting recovered output");
      return;
    }
    if(frame.sequence!==(prior?.sequence ?? 0)+1) throw new Error("Out-of-order execution output");
    const total=(prior?.bytes ?? 0)+bytes.length;
    if(total>1048576) throw new Error("Outpost output limit exceeded");
    await ctx.state.set(chunkScope,chunk);
    await ctx.state.set(scope(companyId,outpostId,frame.operationId,"cursor"),{runId:frame.runId,operationId:frame.operationId,sequence:frame.sequence,bytes:total});
  };
  const read=async (companyId:string,outpostId:string,operationId:string,afterSequence:number) => {
    const receipt=await cursor(companyId,outpostId,operationId);
    const chunks=[];
    for(let sequence=afterSequence+1; receipt && sequence<=Math.min(receipt.sequence,afterSequence+32); sequence++) {
      const chunk=await ctx.state.get(scope(companyId,outpostId,operationId,String(sequence)));
      if(!chunk) throw new Error("Retained output is unavailable");
      chunks.push(chunk);
    }
    return {receipt,chunks};
  };
  return {accept,read};
}
