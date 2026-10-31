import type { PluginSettings, PluginMachines } from '@hyperfide/plugin-sdk';
import { createMachineOps, type SdkFactory } from './machine-ops.js';
import { blaxelSdkFactory } from './sdk.js';
import { machineProvider } from './provider.js';

export const SETTING_DESCRIPTORS = {
  HYPERFIDE_BLAXEL_API_KEY: { type: 'string', secret: true, label: 'Blaxel API key' },
  HYPERFIDE_BLAXEL_WORKSPACE: { type: 'string', secret: true, label: 'Blaxel workspace' },
  region: { type: 'string', label: 'Region', default: '', description: 'Empty uses the SDK default region' },
} as const;
export function createBlaxelPlugin(factory: SdkFactory = blaxelSdkFactory) {
  return async (api: { settings: PluginSettings; experimental_machines: PluginMachines }) => {
    const settings = api.settings.define(SETTING_DESCRIPTORS);
    const resolve = async () => {
      const values = await settings.get();
      return values.HYPERFIDE_BLAXEL_API_KEY && values.HYPERFIDE_BLAXEL_WORKSPACE
        ? { apiKey: values.HYPERFIDE_BLAXEL_API_KEY, workspace: values.HYPERFIDE_BLAXEL_WORKSPACE } : null;
    };
    const definition = machineProvider(createMachineOps(resolve, factory), resolve, async () => (await settings.get()).region);
    api.experimental_machines.register(definition);
  };
}
export default createBlaxelPlugin();
