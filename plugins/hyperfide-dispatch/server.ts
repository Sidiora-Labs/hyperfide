export {
  registerFleetRpc,
  createFleetHandlers,
  type FleetBackend,
} from "./src/fleet-view/rpc.js";

import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { registerFleetRpc, type FleetBackend } from "./src/fleet-view/rpc.js";
import { authoritativeLedgerSchema } from "./src/fleet-view/contract.js";

import { ImageBuilder } from "./src/image-builder/builder.js";
import { registerImageBuilder } from "./src/image-builder/rpc.js";
import { createServerBackend, registerServerImageBuilder } from "./src/server-backend.js";
import { registerManagerDecisions } from "./src/manager.js";
import { dispatchSettings, registerDispatcher } from "./src/server-runtime.js";
import { authorityConfiguration, createAuthorityClient } from "@hyperfide/authority";

export function createFleetPlugin(
  backend: FleetBackend,
  builder?: ImageBuilder,
) {
  return (api: HyperfidePluginApi) => {
    registerFleetRpc(api, backend);
    if (builder) registerImageBuilder(api, builder);
  };
}

export { ImageBuilder, gitRunner } from "./src/image-builder/builder.js";
export { registerImageBuilder } from "./src/image-builder/rpc.js";

export default function dispatchPlugin(api: HyperfidePluginApi) {
  const settings = dispatchSettings(api);
  registerManagerDecisions(api);
  registerFleetRpc(api, createServerBackend(api, async () => {
    const authority = authorityConfiguration(process.env);
    if (authority) {
      const client = await createAuthorityClient(authority);
      return authoritativeLedgerSchema.parse(await client.fleetLedger());
    }
    const pluginId = (await settings.get()).dispatch_controlPlanePlugin?.trim();
    if (!pluginId) return null;
    return api.sdk.plugins.callRpc({
      pluginId,
      method: "fleetLedger",
      input: null,
      outputSchema: authoritativeLedgerSchema,
    });
  }));
  registerServerImageBuilder(api, settings);
  registerDispatcher(api, settings);
}
