import { getMachineProvider } from "../plugins/plugin-machine-provider-registry.js";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
type ExperimentalSandboxOperations = NonNullable<ReturnType<NonNullable<HyperfidePluginApi["experimental_machines"]["getSandboxProvider"]>>>;

/** Resolve at call time so disabled/unloaded providers cannot allocate compute. */
export function sandboxProvider(id: string): ExperimentalSandboxOperations | null {
  const registered = getMachineProvider(id)?.provider.sandbox;
  if (!registered) return null;
  const live = () => {
    const current = getMachineProvider(id)?.provider.sandbox;
    if (!current) throw new Error("Machine provider is no longer registered");
    return current;
  };
  return {
    providerId: id,
    capabilities: { ...registered.capabilities },
    create: (options) => {
      const provider = live();
      if (options.fromCheckpoint && !provider.capabilities.checkpoint)
        throw new Error("Machine provider does not support checkpoints");
      return provider.create(options);
    },
    connect: (machine) => live().connect(machine),
    list: () => live().capabilities.list ? live().list() : Promise.resolve([]),
  };
}
