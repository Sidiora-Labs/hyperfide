export {
  registerFleetRpc,
  createFleetHandlers,
  type FleetBackend,
} from "./src/fleet-view/rpc.js";

import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { registerFleetRpc, type FleetBackend } from "./src/fleet-view/rpc.js";

import { ImageBuilder } from "./src/image-builder/builder.js";
import { registerImageBuilder } from "./src/image-builder/rpc.js";

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
