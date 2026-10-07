import { definePlugin, type PluginContext, type PluginApiResponse, type PluginWebSocketAdmission } from "@paperclipai/plugin-sdk";
import { Effect } from "effect";
import { createOutpostWorkflows, type OutpostError } from "./outposts.js";

const apiError = (error:OutpostError):PluginApiResponse => ({
  status: error._tag === "PersistenceFailure" ? 503 : error._tag === "InvalidRegistration" ? 400 :
    error._tag === "OutpostNotFound" ? 404 : error._tag === "IncompatibleVersions" ? 426 : 403,
  body:{error:error.message}, headers:{"Cache-Control":"no-store"},
});
const admissionError = (error:OutpostError):PluginWebSocketAdmission => ({
  status:error._tag === "PersistenceFailure" ? 503 : error._tag === "IncompatibleVersions" ? 426 : error._tag === "ConnectionConflict" ? 409 :
    error._tag === "InvalidCredentials" ? 401 : 403,
});

let workflows: ReturnType<typeof createOutpostWorkflows>;
let ctx:PluginContext;
export default definePlugin({
  setup(context) { return Effect.runPromise(Effect.sync(() => { ctx = context; workflows = createOutpostWorkflows(context); })); },
  onApiRequest(input) {
    return Effect.runPromise(workflows.api(input).pipe(Effect.catchAll(error => Effect.succeed(apiError(error)))));
  },
  onEnvironmentValidateConfig(input) {
    return Effect.runPromise(workflows.validateEnvironment(input));
  },
  onEnvironmentAcquireLease(input) { return workflows.execution.acquire(input); },
  onEnvironmentRealizeWorkspace(input) { return workflows.execution.realize(input); },
  onEnvironmentExecute(input) { return workflows.execution.execute(input); },
  onEnvironmentReleaseLease() { return Promise.resolve(); },
  onWebSocketOpen(input) {
    return Effect.runPromise(workflows.open(input).pipe(Effect.catchAll(error => {
      if (error._tag === "PersistenceFailure") ctx.logger.error("Outpost persistence unavailable");
      return Effect.succeed(admissionError(error));
    })));
  },
  onWebSocketMessage(input) {
    return Effect.runPromise(workflows.message(input).pipe(Effect.catchAll(error => Effect.succeed({close:true, closeCode:error._tag === "PersistenceFailure" ? 1011 as const : 1008 as const}))));
  },
  onWebSocketClose(input) { return Effect.runPromise(workflows.close(input.connectionId)); },
  onShutdown() { return Effect.runPromise(workflows.shutdown()); },
});
