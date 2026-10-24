import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import dispatchPlugin from "../server.js";
import { createServerBackend } from "./server-backend.js";
import { openDispatchStorage } from "./storage.js";
import { z } from "zod";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("loads without reading the bind-gated SDK and publishes all RPC contracts", () => {
  const register = vi.fn((contract: Record<string, { input: z.ZodType; output: z.ZodType }>) => {
    for (const method of Object.values(contract)) {
      z.toJSONSchema(method.input);
      z.toJSONSchema(method.output);
    }
  });
  dispatchPlugin({
    rpc: { register }, onDispose: vi.fn(),
    get sdk() { throw new Error("Server has not bound"); },
  } as unknown as HyperfidePluginApi);
  expect(register).toHaveBeenCalledTimes(2);
  expect(register).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(),
    expect.objectContaining({ experimental_discoverable: true }));
  expect(register).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(),
    expect.objectContaining({ experimental_discoverable: true }));
});

it("joins persisted dispatch jobs to registered machines and the spec read model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-dispatch-server-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, "plugins", "hyperfide-dispatch");
  await mkdir(directory, { recursive: true });
  const storage = await openDispatchStorage(directory);
  cleanup.push(async () => storage.close());
  await storage.put("job:job-1", { id: "job-1", task: "1.1", state: "running", attempt: 1,
    machine: "machine-1", keyId: "key-1", commits: [] });
  await storage.put("fleet.control", { cap: 2, maximum: 4, paused: false });
  const callRpc = vi.fn(async () => [{ id: "feature", tasks: [{ id: "1.1", status: "in_progress" }] }]);
  const remove = vi.fn();
  const backend = createServerBackend({
    pluginId: "hyperfide-dispatch", server: { experimental_dataDir: dataDir },
    onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    storage: { kv: { get: async () => undefined } },
    sdk: {
      hosts: {
        list: async () => [{ id: "machine-1", machineProviderId: "hyperfide-machine-test",
          lifecycle: { phase: "active" }, createdAt: 0 }],
        get: async () => ({ machineProviderId: "hyperfide-machine-test" }),
        experimental_listProviders: async () => [{ id: "hyperfide-machine-test" }], delete: remove,
      },
      projects: { list: async () => [{ sources: [{ path: "/repository" }] }] },
      plugins: { callRpc },
    },
  } as unknown as HyperfidePluginApi);
  const ledger = await backend.readLedger();
  expect(ledger.jobs[0].task).toBe("feature/1.1");
  expect(ledger.machines[0].job).toBe("job-1");
  expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "hyperfide-spec", method: "features" }));
  await backend.setPaused(true);
  await backend.setCap(3);
  expect((await backend.readLedger()).budget).toMatchObject({ cap: 3, maximum: 4, paused: true });
  await backend.cancelJob("job-1");
  expect(remove).toHaveBeenCalledWith({ hostId: "machine-1" });
  expect(await storage.get("job:job-1")).toMatchObject({ state: "failed", cancelled: true });
});
