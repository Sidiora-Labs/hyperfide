import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { SETTING_DESCRIPTORS, resolveSettings } from "./configuration.js";
import { createMachineOps, type RailwayClientFactory } from "./src/machine-ops.js";
import { createProvider } from "./src/provider.js";
export function createRailwayPlugin(factory?: RailwayClientFactory) {
  return (host: HyperfidePluginApi) => {
    const settings = host.settings.define(SETTING_DESCRIPTORS);
    const resolve = async () => resolveSettings(await settings.get());
    host.experimental_machines.register(createProvider(createMachineOps(resolve, factory), resolve, host.storage.kv));
  };
}
export default createRailwayPlugin();
