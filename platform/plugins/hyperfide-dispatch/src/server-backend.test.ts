import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import dispatchPlugin from "../server.js";
import { createServerBackend } from "./server-backend.js";
import { openDispatchStorage } from "./storage.js";
import { z } from "zod";
import { createFleetHandlers } from "./fleet-view/rpc.js";
import { Dispatcher } from "./dispatcher/dispatcher.js";
import { FakeMachineProvider } from "./testing/fake-machine.js";
import { EchoRunner } from "./testing/echo-runner.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("reports paused, idle and no providers and upserts imported timelines", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-import-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, "plugins", "hyperfide-dispatch");
  const tasks = vi.fn(async () => []);
  const dispatcher = new Dispatcher({
    directory, machines: new FakeMachineProvider(), runner: new EchoRunner(),
    cap: 8, keys: [], spec: { tasks, merged: async () => false,
      claim: async () => false, release: async () => {} },
    limits: async () => ({ global: 8, host: 8, otherRunning: 0 }),
    checkpoint: async () => "parent", prepare: "true",
    integration: async () => ({ tip: "main", bundle: new Uint8Array() }),
    packet: async task => ({ task, prompt: task }),
  });
  await dispatcher.start();
  cleanup.push(async () => dispatcher.close());
  await dispatcher.tick();
  expect(tasks).not.toHaveBeenCalled();
  const backend = createServerBackend({
    pluginId: "hyperfide-dispatch",
    server: { experimental_dataDir: dataDir },
    onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    storage: { kv: { get: async () => undefined } },
    sdk: {
      hosts: {
        list: async () => [],
        experimental_listProviders: async () => [],
      },
      projects: { list: async () => [] },
    },
  } as unknown as HyperfidePluginApi);
  const rpc = createFleetHandlers(backend);
  expect((await rpc.fleetLedger()).budget).toMatchObject({
    paused: true,
    cap: 0,
    status: "Paused; idle; no providers configured",
  });
  const at = "2026-10-24T12:00:00Z";
  const job = {
    id: "external-1",
    task: "feature/1",
    state: "running" as const,
    attempt: 1,
    keyId: "external-key",
    commits: [],
    started: at,
    worker: "external-worker",
    log: "task started",
    events: [{ stage: "started" as const, at }],
  };
  await rpc.fleetImportLedgers({ source: "external-tool", jobs: [job] });
  const ledger = await rpc.fleetImportLedgers({
    source: "external-tool",
    jobs: [
      {
        ...job,
        state: "succeeded",
        finished: at,
        log: "complete",
        events: [...job.events, { stage: "finished", at }],
      },
    ],
  });
  expect(ledger.jobs).toHaveLength(1);
  expect(ledger.jobs[0]).toMatchObject({
    source: "external-tool",
    worker: "external-worker",
    started: at,
    finished: at,
    log: "complete",
  });
  expect(ledger.timelines[0].events.map((event) => event.stage)).toEqual([
    "started",
    "finished",
  ]);
});

it("loads without reading the bind-gated SDK and publishes all RPC contracts", () => {
  const register = vi.fn(
    (contract: Record<string, { input: z.ZodType; output: z.ZodType }>) => {
      for (const method of Object.values(contract)) {
        z.toJSONSchema(method.input);
        z.toJSONSchema(method.output);
      }
    },
  );
  dispatchPlugin({
    settings: { define: vi.fn(() => ({ get: async () => ({}) })) },
    rpc: { register },
    onDispose: vi.fn(),
    get sdk() {
      throw new Error("Server has not bound");
    },
  } as unknown as HyperfidePluginApi);
  expect(register).toHaveBeenCalledTimes(2);
  expect(register).toHaveBeenNthCalledWith(
    1,
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ experimental_discoverable: true }),
  );
  expect(register).toHaveBeenNthCalledWith(
    2,
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ experimental_discoverable: true }),
  );
});

it("joins persisted dispatch jobs to registered machines and the spec read model", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-dispatch-server-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, "plugins", "hyperfide-dispatch");
  await mkdir(directory, { recursive: true });
  const storage = await openDispatchStorage(directory);
  cleanup.push(async () => storage.close());
  await storage.put("job:job-1", {
    id: "job-1",
    task: "1.1",
    state: "running",
    attempt: 1,
    machine: "machine-1",
    keyId: "key-1",
    commits: [],
  });
  await storage.put("fleet.control", { cap: 2, maximum: 4, paused: false });
  const callRpc = vi.fn(async () => [
    { id: "feature", tasks: [{ id: "1.1", status: "in_progress" }] },
  ]);
  const remove = vi.fn();
  const backend = createServerBackend({
    pluginId: "hyperfide-dispatch",
    server: { experimental_dataDir: dataDir },
    onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    storage: { kv: { get: async () => undefined } },
    sdk: {
      hosts: {
        list: async () => [
          {
            id: "machine-1",
            machineProviderId: "hyperfide-machine-test",
            lifecycle: { phase: "active" },
            createdAt: 0,
          },
        ],
        get: async () => ({ machineProviderId: "hyperfide-machine-test" }),
        experimental_listProviders: async () => [
          { id: "hyperfide-machine-test" },
        ],
        delete: remove,
      },
      projects: { list: async () => [{ sources: [{ path: "/repository" }] }] },
      plugins: { callRpc },
    },
  } as unknown as HyperfidePluginApi);
  const ledger = await backend.readLedger();
  expect(ledger.jobs[0].task).toBe("feature/1.1");
  expect(ledger.machines[0].job).toBe("job-1");
  expect(callRpc).toHaveBeenCalledWith(
    expect.objectContaining({ pluginId: "hyperfide-spec", method: "features" }),
  );
  await backend.setPaused(true);
  await backend.setCap(3);
  expect((await backend.readLedger()).budget).toMatchObject({
    cap: 3,
    maximum: 4,
    paused: true,
  });
  await backend.cancelJob("job-1");
  expect(remove).toHaveBeenCalledWith({ hostId: "machine-1" });
  expect(await storage.get("job:job-1")).toMatchObject({
    state: "failed",
    cancelled: true,
  });
});
