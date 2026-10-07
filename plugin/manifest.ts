import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { versions } from "./versions.js";

export default {
  id: "yelqo.outpost", apiVersion: 1, version: versions.plugin, displayName: "Outpost",
  description: "Authenticated outbound connections from prepared Linux execution hosts.",
  author: "Yelqo", categories: ["automation"],
  capabilities: ["api.routes.register", "transport.websockets.register", "plugin.state.read", "plugin.state.write", "activity.log.write", "environment.drivers.register"],
  webSocketRoutes:[{routeKey:"transport"}],
  entrypoints: { worker: "./dist/worker.js" },
  apiRoutes: [
    {routeKey:"register", method:"POST", path:"/outposts", auth:"board", capability:"api.routes.register", companyResolution:{from:"body",key:"companyId"}},
    {routeKey:"status", method:"GET", path:"/outposts/:outpostId", auth:"board", capability:"api.routes.register", companyResolution:{from:"query",key:"companyId"}},
    {routeKey:"revoke", method:"POST", path:"/outposts/:outpostId/revoke", auth:"board", capability:"api.routes.register", companyResolution:{from:"body",key:"companyId"}},
  ],
  environmentDrivers: [{
    driverKey:"outpost", kind:"sandbox_provider", displayName:"Outpost", companyScopeConfigKey:"companyId",
    workspaceRealization:"in_place",
    description:"Bounded commands in an existing workspace on a registered Outpost.",
    configSchema:{type:"object", properties:{outpostId:{type:"string"},companyId:{type:"string"}}, required:["outpostId","companyId"], additionalProperties:false},
  }],
} satisfies PaperclipPluginManifestV1;
