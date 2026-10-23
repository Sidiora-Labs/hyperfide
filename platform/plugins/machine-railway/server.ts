import type { PluginMachineProviderDefinition } from "@hyperfide/plugin-sdk/machine-provider";
import { SETTING_DESCRIPTORS, resolveSettings, type RawSettings } from "./configuration.js";
import { createMachineOps, type RailwayClientFactory } from "./src/machine-ops.js";
import { createProvider, type AllocationStore } from "./src/provider.js";
export interface RailwayPluginHost {
  settings: { define(descriptors: typeof SETTING_DESCRIPTORS): { get(): Promise<RawSettings> } };
  storage: { kv: AllocationStore };
  experimental_machines: { register(definition: PluginMachineProviderDefinition<undefined>): void };
}
export function createRailwayPlugin(factory?: RailwayClientFactory) {
  return (host: RailwayPluginHost) => {
    const settings = host.settings.define(SETTING_DESCRIPTORS);
    const resolve = async () => resolveSettings(await settings.get());
    host.experimental_machines.register(createProvider(createMachineOps(resolve, factory), resolve, host.storage.kv));
  };
}
export default createRailwayPlugin();
