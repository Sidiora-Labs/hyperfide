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
    background: { service: vi.fn() },
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

it("starts the default server dispatcher paused with no providers and stops on dispose", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-service-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  let service: { start(signal: AbortSignal): Promise<void> } | undefined;
  const controller = new AbortController();
  const api = {
    pluginId: "hyperfide-dispatch", server: { experimental_dataDir: dataDir },
    settings: { define: () => ({ get: async () => ({}) }) },
    rpc: { register: vi.fn() }, onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    background: { service: (_: string, value: typeof service) => { service = value; } },
    storage: { kv: { get: async () => undefined } },
    sdk: { hosts: { list: async () => [], experimental_listProviders: async () => [] }, projects: { list: async () => [] } },
  } as unknown as HyperfidePluginApi;
  dispatchPlugin(api);
  expect(service).toBeDefined();
  const running = service!.start(controller.signal);
  cleanup.push(async () => { controller.abort(); await running; });
  const backend = createServerBackend(api);
  await vi.waitFor(async () => {
    expect((await backend.readLedger()).budget).toMatchObject({ paused: true, cap: 0, maximum: 0, status: "Paused; idle; no providers configured" });
  });
  controller.abort();
  await running;
});

it("builds an image through the registered provider create and checkpoint operations", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const { registerServerImageBuilder } = await import("./server-backend.js");
  const dataDir = await mkdtemp(join(tmpdir(), "hyperfide-provider-build-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const git = promisify(execFile);
  await git("git", ["init", "-b", "main"], { cwd: dataDir });
  await git("git", ["-c", "user.name=Hyperfide", "-c", "user.email=tests@localhost", "commit", "--allow-empty", "-m", "base"], { cwd: dataDir });
  const fleetPath = join(dataDir, "fleet.json");
  await writeFile(fleetPath, JSON.stringify({ checkpoint: "parent", workspace: "/workspace", shellPrefix: "", base: { steps: [["prepare", "true", 10]] } }));
  const checkpoint = vi.fn(async (name: string) => ({ name }));
  const destroy = vi.fn(async () => {});
  const create = vi.fn(async () => ({ id: "builder", checkpoint, destroy,
    writeFile: vi.fn(async () => {}), exec: vi.fn(async () => ({ exitCode: 0, stdout: "built", stderr: "", timedOut: false, truncated: false, ms: 1 })) }));
  const values = new Map<string, unknown>();
  let handlers: Record<string, (input?: any) => Promise<any>> = {};
  registerServerImageBuilder({
    onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    settings: { define: () => ({ get: async () => ({ dispatch_repository: dataDir, dispatch_fleetPath: fleetPath }) }) },
    rpc: { register: (_: unknown, value: typeof handlers) => { handlers = value; } },
    storage: { kv: { list: async () => [...values.keys()], get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value); } } },
    sdk: { hosts: { experimental_listProviders: async () => [{ id: "registered" }] } },
    experimental_machines: { getSandboxProvider: () => ({ capabilities: { checkpoint: true }, create }) },
  } as unknown as HyperfidePluginApi);
  expect(await handlers.imageBuildConfiguration()).toMatchObject({ configured: true });
  const build = await handlers.imageBuildStart({ commit: "main" });
  await vi.waitFor(async () => {
    expect((await handlers.imageBuilds()).find((record: any) => record.id === build.id)).toMatchObject({ status: "succeeded", checkpoint: expect.stringContaining("hf-base-") });
  });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ fromCheckpoint: "parent" }));
  expect(checkpoint).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
});

it("ticks after an operator resumes and applies registered compute, spec tasks and concurrency limits", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "hyperfide-live-dispatch-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const git = promisify(execFile);
  await git("git", ["init", "-b", "main"], { cwd: directory });
  await git("git", ["-c", "user.name=Hyperfide", "-c", "user.email=tests@localhost", "commit", "--allow-empty", "-m", "base"], { cwd: directory });
  const fleetPath = join(directory, "fleet.json");
  await writeFile(fleetPath, JSON.stringify({ checkpoint: "base", dispatcher: {
    feature: "feature", integrationRef: "main", prepare: "true", runner: "codex", mcp: {},
  } }));
  const machines = new FakeMachineProvider();
  const seed = await machines.create();
  await seed.checkpoint("base");
  await seed.destroy();
  machines.scripts.push({ pattern: /codex/, result: { stdout: "secret-gateway completed" } });
  const task = { id: "1", feature: "feature", title: "Task", status: "pending", wave: 1,
    requires: [], touches: [], verify_cmd: "true", do: [], reqs: [], owner: "test", criteria: [] };
  let service: { start(signal: AbortSignal): Promise<void> } | undefined;
  const callRpc = vi.fn(async ({ method }: { method: string }) => method === "getConfiguration"
    ? { globalLimit: 2, hosts: [{ id: "host", effectiveLimit: 2 }] }
    : method === "tasks" ? [task] : [{ id: "feature", tasks: [task] }]);
  const api = {
    pluginId: "hyperfide-dispatch", server: { experimental_dataDir: directory },
    settings: { define: () => ({ get: async () => ({ dispatch_repository: directory, dispatch_fleetPath: fleetPath,
      dispatch_gatewayKeys: JSON.stringify([{ id: "key", value: "secret-gateway", concurrency: 1 }]), dispatch_intervalMs: 100 }) }) },
    rpc: { register: vi.fn() }, onDispose: (close: () => Promise<unknown>) => cleanup.push(close),
    background: { service: (_: string, value: typeof service) => { service = value; } },
    experimental_machines: { getSandboxProvider: () => machines },
    log: { warn: vi.fn() }, storage: { kv: { get: async () => undefined } },
    sdk: { hosts: { list: async () => [], experimental_listProviders: async () => [{ id: machines.providerId }] },
      projects: { list: async () => [] }, plugins: { callRpc }, threads: { listRunning: async () => [] } },
  } as unknown as HyperfidePluginApi;
  dispatchPlugin(api);
  const controller = new AbortController();
  const running = service!.start(controller.signal);
  cleanup.push(async () => { controller.abort(); await running; });
  const backend = createServerBackend(api);
  await vi.waitFor(async () => expect((await backend.readLedger()).budget.maximum).toBe(1));
  expect(machines.execLog).toHaveLength(0);
  await backend.setCap(1);
  await backend.setPaused(false);
  await vi.waitFor(async () => expect((await backend.readLedger()).jobs[0]?.state).toBe("succeeded"), { timeout: 10000 });
  const ledger = await backend.readLedger();
  expect(ledger.jobs[0].log).toContain("[redacted] completed");
  expect(JSON.stringify(ledger)).not.toContain("secret-gateway");
  expect(ledger.timelines[0].events.map(event => event.stage)).toEqual(["claimed", "started", "finished"]);
  expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "concurrency-limit", method: "getConfiguration" }));
  controller.abort();
  await running;
});
