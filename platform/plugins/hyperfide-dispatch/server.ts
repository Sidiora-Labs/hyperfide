export {
  registerFleetRpc,
  createFleetHandlers,
  type FleetBackend,
} from "./src/fleet-view/rpc.js";

import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { registerFleetRpc, type FleetBackend } from "./src/fleet-view/rpc.js";

import { ImageBuilder } from "./src/image-builder/builder.js";
import { registerImageBuilder } from "./src/image-builder/rpc.js";
import { createServerBackend, registerServerImageBuilder } from "./src/server-backend.js";
import { dispatchSettings, registerDispatcher } from "./src/server-runtime.js";

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
  registerFleetRpc(api, createServerBackend(api));
  registerServerImageBuilder(api, settings);
  registerDispatcher(api, settings);
}
