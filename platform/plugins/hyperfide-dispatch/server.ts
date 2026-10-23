export {
  registerFleetRpc,
  createFleetHandlers,
  type FleetBackend,
} from "./src/fleet-view/rpc.js";

import type { BbPluginApi } from "@hyperfide/plugin-sdk";
import { registerFleetRpc, type FleetBackend } from "./src/fleet-view/rpc.js";

export function createFleetPlugin(backend: FleetBackend) {
  return (api: BbPluginApi) => registerFleetRpc(api, backend);
}
