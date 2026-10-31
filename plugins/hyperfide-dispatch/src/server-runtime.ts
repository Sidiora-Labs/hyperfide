import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { Dispatcher } from "./dispatcher/dispatcher.js";
import { commandRunner, isFleetRunnerKind, imageRunnerKinds } from "./dispatcher/runners.js";
import type { SandboxMachineOps } from "./machine-ops.js";
import { openDispatchStorage } from "./storage.js";
import { taskSchema } from "../../hyperfide-spec/src/shared/contract.js";
import { taskPacket } from "../../hyperfide-spec/src/shared/packet.js";

export function dispatchSettings(api: HyperfidePluginApi) {
  return api.settings.define({
    dispatch_repository: { type: "string", label: "Repository path (dispatch.repository)" },
    dispatch_fleetPath: { type: "string", label: "Fleet configuration path (dispatch.fleetPath)" },
    dispatch_gatewayKeys: { type: "string", secret: true, label: "Gateway keys JSON (id, value, concurrency)" },
    dispatch_intervalMs: { type: "number", label: "Dispatcher tick interval (milliseconds)", default: 15000 },
  });
}
export type DispatchSettings = ReturnType<typeof dispatchSettings>;

export async function registeredMachines(api: HyperfidePluginApi): Promise<SandboxMachineOps | null> {
  for (const provider of await api.sdk.hosts.experimental_listProviders()) {
    const operations = api.experimental_machines?.getSandboxProvider?.(provider.id);
    if (operations?.capabilities.checkpoint) return operations;
  }
  return null;
}

const configSchema = z.object({
  checkpoint: z.string().nullable(),
  dispatcher: z.object({
    feature: z.string().min(1), integrationRef: z.string().min(1),
    prepare: z.string().min(1), runner: z.string().refine(isFleetRunnerKind, "Unknown fleet runner kind"),
    mcp: z.record(z.string(), z.unknown()),
  }),
});
const keysSchema = z.array(z.object({ id: z.string().min(1), value: z.string().min(1), concurrency: z.number().int().positive() }));
const limitsSchema = z.object({ globalLimit: z.number().nullable(), hosts: z.array(z.object({ id: z.string(), effectiveLimit: z.number() })) });
const git = promisify(execFile);

/** The background service starts after SDK bind and owns exactly one dispatcher. */
export function registerDispatcher(api: HyperfidePluginApi, settings: DispatchSettings) {
  api.background.service("dispatcher", {
    async start(signal) {
      const directory = join(api.server.experimental_dataDir, "plugins", api.pluginId);
      await mkdir(directory, { recursive: true });
      const storage = await openDispatchStorage(directory);
      let dispatcher: Dispatcher | undefined;
      let options: z.infer<typeof configSchema> | undefined;
      let repository = "";
      const machines: SandboxMachineOps = {
        providerId: "registered", capabilities: { checkpoint: true, list: true },
        async create(input) {
          const provider = await registeredMachines(api);
          if (!provider) throw new Error("no checkpoint-capable provider");
          const machine = await provider.create(input);
          await storage.put(`machine:${machine.id}`, provider.providerId);
          return machine;
        },
        async connect(id) {
          const providerId = await storage.get(`machine:${id}`);
          const provider = typeof providerId === "string" ? api.experimental_machines?.getSandboxProvider?.(providerId) : null;
          if (!provider) throw new Error("Machine provider unavailable");
          return provider.connect(id);
        },
        async list() {
          const entries = await storage.entries();
          const result = [];
          for (const provider of await api.sdk.hosts.experimental_listProviders()) {
            if (!entries.some(entry => entry.key.startsWith("machine:") && entry.value === provider.id)) continue;
            const ops = api.experimental_machines?.getSandboxProvider?.(provider.id);
            if (ops?.capabilities.list) result.push(...(await ops.list()).filter(machine => entries.some(entry => entry.key === `machine:${machine.id}`)));
          }
          return result;
        },
      };
      const readTasks = async () => api.sdk.plugins.callRpc({
        pluginId: "hyperfide-spec", method: "tasks",
        input: { repository, feature: options!.dispatcher.feature }, outputSchema: z.array(taskSchema),
      });
      try {
        const values = await settings.get();
        const keys = keysSchema.parse(JSON.parse(values.dispatch_gatewayKeys || "[]"));
        await storage.put("fleet.keys", keys.length);
        dispatcher = new Dispatcher({
          directory, storage, machines, keys, cap: keys.reduce((sum, key) => sum + key.concurrency, 0),
          prepare: "", runner: { async run(packet, machine, key) {
            return commandRunner(options!.dispatcher.runner, options!.dispatcher.mcp).run(packet, machine, key);
          } },
          spec: {
            tasks: readTasks,
            async merged(task, tip) {
              const result = await git("git", ["log", "--format=%B", tip, "--"], { cwd: repository });
              return result.stdout.includes(`[spec:${options!.dispatcher.feature}/${task}]`);
            },
            async claim(task, job) {
              if (await storage.get(`claim:${task}`)) return false;
              await storage.put(`claim:${task}`, job);
              return true;
            },
            async release(task, job) {
              if (await storage.get(`claim:${task}`) === job) await storage.put(`claim:${task}`, null);
            },
          },
          async limits() {
            const snapshot = await api.sdk.plugins.callRpc({ pluginId: "concurrency-limit", method: "getConfiguration", input: null, outputSchema: limitsSchema });
            const running = await api.sdk.threads.listRunning();
            return { global: snapshot.globalLimit ?? Number.MAX_SAFE_INTEGER,
              host: snapshot.hosts.length ? Math.min(...snapshot.hosts.map(host => host.effectiveLimit)) : 0,
              otherRunning: running.length };
          },
          async checkpoint() {
            if (!options?.checkpoint) throw new Error("Configure a fleet checkpoint");
            return options.checkpoint;
          },
          async integration() {
            const temporary = await mkdtemp(join(tmpdir(), "hyperfide-dispatch-bundle-"));
            try {
              const tip = (await git("git", ["rev-parse", "--verify", "--end-of-options", `${options!.dispatcher.integrationRef}^{commit}`], { cwd: repository })).stdout.trim();
              const path = join(temporary, "integration.bundle");
              await git("git", ["bundle", "create", path, options!.dispatcher.integrationRef], { cwd: repository });
              return { tip, bundle: await readFile(path) };
            } finally { await rm(temporary, { recursive: true, force: true }); }
          },
          async packet(id) {
            const task = (await readTasks()).find(task => task.id === id);
            if (!task) throw new Error("Task disappeared from spec read model");
            const tip = (await git("git", ["rev-parse", "--verify", "--end-of-options", `${options!.dispatcher.integrationRef}^{commit}`], { cwd: repository })).stdout.trim();
            return { task: id, prompt: taskPacket(options!.dispatcher.feature, id, { ...task }, tip, "") };
          },
        });
        await dispatcher.start();
        while (!signal.aborted) {
          try {
            const current = await settings.get();
            const control = await storage.get("fleet.control") as { paused: boolean; cap: number };
            if (!control.paused && control.cap > 0 && current.dispatch_repository && current.dispatch_fleetPath && await registeredMachines(api)) {
              repository = current.dispatch_repository;
              const fleet = JSON.parse(await readFile(current.dispatch_fleetPath, "utf8"));
              options = configSchema.parse(fleet);
              if (!imageRunnerKinds(fleet).includes(options.dispatcher.runner))
                throw new Error("Runner is unavailable in the configured fleet image");
              dispatcher.setPrepare(options.dispatcher.prepare);
              await dispatcher.tick();
            }
          } catch {
            // Provider/configuration failures never expose credentials in diagnostics.
            api.log.warn("Dispatcher tick failed; check fleet configuration and provider availability");
          }
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
            const timer = setTimeout(finish, Math.max(100, values.dispatch_intervalMs ?? 15000));
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) finish();
          });
        }
      } finally {
        await dispatcher?.stop();
        storage.close();
      }
    },
  });
}
