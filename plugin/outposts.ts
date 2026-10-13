import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Data, Effect, Exit, Scope } from "effect";
import type { PluginContext, PluginApiRequestInput, PluginApiResponse, PluginWebSocketOpen, PluginWebSocketEvent, PluginWebSocketAdmission, PluginWebSocketReply } from "@paperclipai/plugin-sdk";
import type { PluginEnvironmentValidateConfigParams } from "@paperclipai/plugin-sdk/protocol";
import { versions } from "./versions.js";
import { createExecutionWorkflows } from "./execution.js";
import { readExecutionRecord, recordDigest, type ExecutionRecord } from "./recovery.js";

export class InvalidCredentials extends Data.TaggedError("InvalidCredentials") { readonly message = "Invalid outpost credentials"; }
export class RevokedOutpost extends Data.TaggedError("RevokedOutpost") { readonly message = "Outpost has been revoked"; }
export class IncompatibleVersions extends Data.TaggedError("IncompatibleVersions") { readonly message = "Incompatible Outpost versions"; }
export class PersistenceFailure extends Data.TaggedError("PersistenceFailure") { readonly message = "Outpost persistence unavailable"; }
export class InvalidRegistration extends Data.TaggedError("InvalidRegistration") { readonly message = "A name of 1–100 letters, numbers, spaces, dots, underscores or hyphens is required"; }
export class OutpostNotFound extends Data.TaggedError("OutpostNotFound") { readonly message = "Outpost not found"; }
export class ConnectionConflict extends Data.TaggedError("ConnectionConflict") { readonly message = "Outpost is already connected"; }
export type OutpostError = InvalidCredentials | RevokedOutpost | IncompatibleVersions | PersistenceFailure | InvalidRegistration | OutpostNotFound | ConnectionConflict;

type Outpost = { id:string; companyId:string; name:string; credentialHash:string; revoked:boolean };
type Session = { outpostId:string; companyId:string; scope:Scope.CloseableScope; authenticated?:boolean; reconciled?:boolean;
  outputRetention?:unknown; draining?:boolean;
  expected?:ExecutionRecord[]; inventory?:Map<string,string>; recovery?:Array<{operationId:string;record?:ExecutionRecord}>; recoveryIndex?:number };
const uuid = (value:unknown):value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const digest = (value:string) => createHash("sha256").update(value).digest();
const stateKey = (companyId:string, id:string) => ({scopeKind:"company" as const, scopeId:companyId, stateKey:`outpost:${id}`});
function validVersions(value:unknown):boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string,unknown>;
  return Object.entries(versions).every(([key,version]) => candidate[key] === version);
}

/** SDK promises are adapted here; the workflows above this boundary use Effects. */
export function createOutpostWorkflows(ctx:PluginContext) {
  const sessions = new Map<string,Session>();
  const online = (companyId:string,outpostId:string) => [...sessions.values()].some(s => s.authenticated && s.reconciled && s.companyId===companyId && s.outpostId===outpostId);
  const admitting = (companyId:string,outpostId:string) => [...sessions.values()].some(s => s.authenticated && s.reconciled && s.draining===false && s.companyId===companyId && s.outpostId===outpostId);
  const execution = createExecutionWorkflows(ctx,online,admitting);
  const persistence = <A>(operation:() => Promise<A>) => Effect.tryPromise({try:operation, catch:() => new PersistenceFailure()});
  const read = (companyId:string,id:string) => persistence(() => ctx.state.get(stateKey(companyId,id))).pipe(Effect.map(value => value as Outpost | null));
  const write = (record:Outpost) => persistence(() => ctx.state.set(stateKey(record.companyId,record.id),record));
  const audit = (record:Outpost,message:string) => persistence(() => ctx.activity.log({companyId:record.companyId,message,entityType:"outpost",entityId:record.id}));

  const register = (input:PluginApiRequestInput) => Effect.gen(function* () {
    const body = input.body as Record<string,unknown> | null;
    if (typeof body?.name !== "string" || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(body.name)) return yield* Effect.fail(new InvalidRegistration());
    const credential = `outpost_${randomBytes(32).toString("base64url")}`;
    const record:Outpost = {id:randomUUID(),companyId:input.companyId,name:body.name,credentialHash:digest(credential).toString("hex"),revoked:false};
    yield* write(record);
    yield* audit(record,"Outpost registered").pipe(Effect.onError(() => write({...record,revoked:true}).pipe(Effect.ignore)));
    return {status:201,headers:{"Cache-Control":"no-store"},body:{outpostId:record.id,name:record.name,companyId:record.companyId,credential,versions}} satisfies PluginApiResponse;
  });
  const revoke = (record:Outpost) => Effect.gen(function* () {
    yield* write({...record,revoked:true});
    yield* audit(record,"Outpost revoked");
    return {status:204} satisfies PluginApiResponse;
  });
  const api = (input:PluginApiRequestInput):Effect.Effect<PluginApiResponse,OutpostError> => Effect.gen(function* () {
    if (input.actor.actorType !== "user") return yield* Effect.fail(new InvalidCredentials());
    if (input.routeKey === "register") return yield* register(input);
    const record = yield* read(input.companyId,input.params.outpostId ?? "");
    if (!record) return yield* Effect.fail(new OutpostNotFound());
    if (input.routeKey === "revoke") return yield* revoke(record);
    if(input.routeKey === "output") {
      const operationId=input.query.operationId;
      const afterSequence=Number(input.query.afterSequence ?? 0);
      if(typeof operationId!=="string" || !operationId || !Number.isSafeInteger(afterSequence) || afterSequence<0) return {status:400,body:{error:"operationId and a nonnegative afterSequence are required"}};
      const output=yield* persistence(()=>execution.output.read(record.companyId,record.id,operationId,afterSequence));
      return {headers:{"Cache-Control":"no-store"},body:output};
    }
    const connected = [...sessions.values()].some(session => session.authenticated && session.companyId === record.companyId && session.outpostId === record.id);
    const executionReady = admitting(record.companyId,record.id);
    const draining = [...sessions.values()].some(session => session.authenticated && session.draining && session.companyId === record.companyId && session.outpostId === record.id);
    const executionHistory=yield* persistence(()=>execution.history.all(record.companyId,record.id));
    const outputRetention=[...sessions.values()].find(session=>session.companyId===record.companyId && session.outpostId===record.id)?.outputRetention;
    return {headers:{"Cache-Control":"no-store"},body:{outpostId:record.id,name:record.name,companyId:record.companyId,revoked:record.revoked,connected,executionReady,draining,executionHistory,outputRetention}};
  });
  const authenticate = (input:PluginWebSocketOpen) => Effect.gen(function* () {
    const id = input.query.outpostId;
    const credential = input.headers.authorization?.match(/^Bearer (outpost_[A-Za-z0-9_-]{43})$/)?.[1];
    if (!uuid(id) || !credential) return yield* Effect.fail(new InvalidCredentials());
    const record = yield* read(input.companyId,id);
    if (!record || record.companyId !== input.companyId || !/^[0-9a-f]{64}$/.test(record.credentialHash) ||
      !timingSafeEqual(digest(credential),Buffer.from(record.credentialHash,"hex"))) return yield* Effect.fail(new InvalidCredentials());
    if (record.revoked) return yield* Effect.fail(new RevokedOutpost());
    return record;
  });
  const validateVersions = (input:PluginWebSocketOpen) => Effect.gen(function* () {
    const client = yield* Effect.try({try:() => JSON.parse(input.headers.versions ?? ""),catch:() => new IncompatibleVersions()});
    if (ctx.manifest.version !== versions.plugin || input.host.commit !== versions.host || input.host.sdk !== versions.sdk || input.host.shared !== versions.shared || input.host.transport !== versions.protocol || !validVersions(client))
      return yield* Effect.fail(new IncompatibleVersions());
  });
  const open = (input:PluginWebSocketOpen):Effect.Effect<PluginWebSocketAdmission,OutpostError> => Effect.gen(function* () {
    const scope = yield* Scope.make();
    const session:Session = {companyId:input.companyId,outpostId:input.query.outpostId ?? "",scope};
    const admission = Effect.gen(function* () {
      // Reserve cleanup before SDK I/O: core may close a pending admission.
      yield* Effect.acquireRelease(Effect.sync(() => {
        sessions.set(input.connectionId,session);
        return session;
      }), () => Effect.sync(() => {
        if (sessions.get(input.connectionId) === session) {
          sessions.delete(input.connectionId);
          if(session.authenticated) execution.close(session.companyId,session.outpostId);
        }
      }));
      const record = yield* authenticate(input);
      yield* validateVersions(input);
      if (sessions.get(input.connectionId) !== session) return yield* Effect.fail(new InvalidCredentials());
      if ([...sessions.values()].some(value => value !== session && value.authenticated && value.outpostId === record.id))
        return yield* Effect.fail(new ConnectionConflict());
      session.authenticated = true;
      return {status:101,principalId:record.id,messages:[JSON.stringify({type:"ready",outpostId:record.id,companyId:record.companyId,versions,recoveryRequired:true})]} satisfies PluginWebSocketAdmission;
    });
    return yield* admission.pipe(Effect.provideService(Scope.Scope,scope),Effect.onError(() => Scope.close(scope,Exit.void)));
  });
  const message = (input:PluginWebSocketEvent):Effect.Effect<PluginWebSocketReply,OutpostError> => Effect.gen(function* () {
    const session = sessions.get(input.connectionId);
    if (!session?.authenticated || session.outpostId !== input.principalId || session.companyId !== input.companyId) return yield* Effect.fail(new InvalidCredentials());
    const record = yield* read(session.companyId,session.outpostId);
    if (!record || record.revoked) return yield* Effect.fail(new RevokedOutpost());
    const data = yield* Effect.try({try:() => JSON.parse(input.data ?? ""),catch:() => new InvalidCredentials()});
    const nextRecovery=() => {
      const expected=session.recovery?.[session.recoveryIndex ?? 0];
      return {messages:[JSON.stringify(expected ? {type:"recovery_probe",...expected} : {type:"recovery_upload"})]};
    };
    if(data?.type==="recovery_begin" && !session.inventory && !session.reconciled) {
      session.expected=yield* persistence(()=>execution.history.all(session.companyId,session.outpostId));
      session.inventory=new Map();
      session.recoveryIndex=0;
      return {messages:[JSON.stringify({type:"recovery_inventory"})]};
    }
    if(data?.type==="recovery_inventory" && session.inventory && !session.recovery) {
      if(!Array.isArray(data.records) || data.records.length>100) return yield* Effect.fail(new InvalidCredentials());
      for(const entry of data.records) {
        if(!Array.isArray(entry) || entry.length!==2 || typeof entry[0]!=="string" || !entry[0] || typeof entry[1]!=="string" ||
          !/^[0-9a-f]{64}$/.test(entry[1]) || session.inventory.has(entry[0])) return yield* Effect.fail(new InvalidCredentials());
        session.inventory.set(entry[0],entry[1]);
      }
      return {messages:[JSON.stringify({type:"ack"})]};
    }
    if(data?.type==="recovery_inventory_complete" && session.inventory && session.expected && !session.recovery) {
      const known=new Set(session.expected.map(record=>record.operationId));
      session.recovery=session.expected.filter(record=>session.inventory!.get(record.operationId)!==recordDigest(record)).map(record=>({operationId:record.operationId,record}));
      for(const operationId of session.inventory.keys()) if(!known.has(operationId)) session.recovery.push({operationId});
      return nextRecovery();
    }
    if(data?.type==="history" || data?.type==="recovery_record") {
      const report=yield* Effect.try({try:()=>readExecutionRecord(data.record),catch:()=>new InvalidCredentials()});
      if(data.type==="recovery_record" && session.recovery?.[session.recoveryIndex ?? 0]?.operationId!==report.operationId) return yield* Effect.fail(new InvalidCredentials());
      const accepted=yield* persistence(()=>execution.history.report(session.companyId,session.outpostId,report));
      yield* persistence(async ()=>{await execution.reconcile(session.companyId,session.outpostId,accepted);});
      if(data.type==="recovery_record") { session.recoveryIndex=(session.recoveryIndex ?? 0)+1; return nextRecovery(); }
      return {messages:[JSON.stringify({type:"ack",deliveryId:data.deliveryId})]};
    }
    if(data?.type==="recovery_complete" && session.recovery && session.recoveryIndex===session.recovery.length) {
      const records=yield* persistence(()=>execution.history.all(session.companyId,session.outpostId));
      execution.restore(session.companyId,session.outpostId,records);
      session.reconciled=true;
      return {messages:[JSON.stringify({type:"recovery_ready"})]};
    }
    if (data?.type === "heartbeat" && Object.keys(data).every(key=>key==="type" || key==="outputRetention" || key==="draining")) {
      if(data.draining!==undefined && typeof data.draining!=="boolean") return yield* Effect.fail(new InvalidCredentials());
      session.draining=data.draining===true;
      const retention=data.outputRetention;
      if(retention!==undefined) {
        if(!retention || typeof retention!=="object" || !["bytes","operations","perOperationBytes","totalBytes","maxOperations"].every(key=>Number.isSafeInteger(retention[key]) && retention[key]>=0)) return yield* Effect.fail(new InvalidCredentials());
        session.outputRetention=retention;
      }
      const operations=session.reconciled ? yield* persistence(()=>execution.drain(session.companyId,session.outpostId)) : [];
      const drainComplete=session.draining && execution.drained(session.companyId,session.outpostId);
      return {messages:[JSON.stringify({type:"pong",operations,drainComplete})]};
    }
    if (data?.type === "output" || data?.type === "result") {
      if(!session.reconciled) return yield* Effect.fail(new InvalidCredentials());
      if(data.record!==undefined) {
        const report=yield* Effect.try({try:()=>readExecutionRecord(data.record),catch:()=>new InvalidCredentials()});
        if(report.operationId!==data.operationId || report.runId!==data.runId) return yield* Effect.fail(new InvalidCredentials());
        const accepted=yield* persistence(()=>execution.history.report(session.companyId,session.outpostId,report));
        yield* persistence(async ()=>{await execution.reconcile(session.companyId,session.outpostId,accepted);});
      } else if(data.type==="result" && data.error && data.beforeLaunch===true && data.operationId) {
        yield* persistence(()=>execution.history.refuse(session.companyId,session.outpostId,data.operationId,data.runId));
      }
      yield* persistence(()=>execution.message(session.companyId,session.outpostId,data));
      return {messages:[JSON.stringify({type:"ack",deliveryId:data.deliveryId})]};
    }
    return yield* Effect.fail(new InvalidCredentials());
  });
  const close = (connectionId:string) => Effect.suspend(() => {
    const session = sessions.get(connectionId);
    return session ? Scope.close(session.scope,Exit.void) : Effect.void;
  });
  const shutdown = () => Effect.forEach([...sessions.keys()],close,{discard:true});
  const validateEnvironment = (input:PluginEnvironmentValidateConfigParams) => Effect.sync(() => {
    const {companyId,outpostId} = input.config;
    return input.driverKey === "outpost" && uuid(companyId) && uuid(outpostId)
      ? {ok:true,normalizedConfig:{companyId,outpostId}}
      : {ok:false,errors:["A registered outpost and company are required"]};
  });
  return {api,open,message,close,shutdown,validateEnvironment,execution};
}
