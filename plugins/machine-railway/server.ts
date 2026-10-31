import { createStatus, railwayIdentity } from "./src/status.js";
import { railwayContract } from "./src/status-contract.js";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { SETTING_DESCRIPTORS, resolveSettings } from "./configuration.js";
import {
  createMachineOps,
  type RailwayClientFactory,
} from "./src/machine-ops.js";
import { createProvider } from "./src/provider.js";
export function createRailwayPlugin(
  factory?: RailwayClientFactory,
  identity = railwayIdentity,
) {
  return (host: HyperfidePluginApi) => {
    const settings = host.settings.define(SETTING_DESCRIPTORS);
    const resolve = async () => resolveSettings(await settings.get());
    const status = createStatus(resolve, host.storage.kv, factory, identity);
    settings.onChange(async () => {
      await host.storage.kv.delete("railway/verification");
    });
    host.rpc.register(railwayContract, {
      railwayStatus: status.status,
      railwayVerify: status.verify,
    });
    host.experimental_machines.register(
      createProvider(
        createMachineOps(resolve, factory),
        resolve,
        host.storage.kv,
      ),
    );
  };
}
export default createRailwayPlugin();
