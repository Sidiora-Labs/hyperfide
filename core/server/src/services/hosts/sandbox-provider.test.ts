import { afterEach, expect, it, vi } from "vitest";
import { sandboxProvider } from "./sandbox-provider.js";
import { setPluginMachineProviderBridge, type PluginMachineProviderRecord } from "../plugins/plugin-machine-provider-registry.js";

afterEach(() => setPluginMachineProviderBridge(undefined));
it("gates checkpoint allocation and refuses allocations after provider unload", async () => {
  const create = vi.fn(async () => ({ id: "machine" }));
  let record = { pluginId: "hyperfide-test", provider: { sandbox: {
    providerId: "hyperfide-machine-test", capabilities: { checkpoint: false, list: false }, create,
  } } } as unknown as PluginMachineProviderRecord | undefined;
  setPluginMachineProviderBridge({
    listMachineProviders: () => record ? [record] : [], getMachineProvider: () => record,
    decisionTimeoutMs: 1000, invokeProvider: async (_, __, run) => ({ ok: true, value: await run() }),
  });
  const operations = sandboxProvider("hyperfide-machine-test")!;
  expect(() => operations.create({ fromCheckpoint: "base" })).toThrow("does not support checkpoints");
  expect(create).not.toHaveBeenCalled();
  expect(await operations.list()).toEqual([]);
  await operations.create({ name: "new" });
  expect(create).toHaveBeenCalledOnce();
  record = undefined;
  expect(() => operations.create({})).toThrow("no longer registered");
  expect(sandboxProvider("hyperfide-machine-test")).toBeNull();
});
