import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FleetBackend } from "./fleet-view/rpc.js";
import type { JobLedger } from "./dispatcher/dispatcher.js";
import { openDispatchStorage, migrateDispatchDirectory } from "./storage.js";
import { imageBuilderContract } from "./image-builder/rpc.js";
import { ImageBuilder, type BuildRecord } from "./image-builder/builder.js";

const featuresSchema = z.array(z.object({
  id: z.string(),
  tasks: z.array(z.object({ id: z.string(), status: z.string() })),
}));

export function createServerBackend(api: HyperfidePluginApi): FleetBackend {
  // Open lazily: the SDK and its registered providers are available after bind.
  let storage: ReturnType<typeof openDispatchStorage> | undefined;
  const store = () => storage ??= (async () => {
    const directory = join(api.server.experimental_dataDir, "plugins", api.pluginId);
    await mkdir(directory, { recursive: true });
    const value = await openDispatchStorage(directory);
    await migrateDispatchDirectory(directory, value);
    return value;
  })();
  api.onDispose(async () => { if (storage) (await storage).close(); });
  const jobs = async () => (await (await store()).entries())
    .filter(entry => entry.key.startsWith("job:"))
    .map(entry => entry.value as JobLedger);
  const destroyMachine = async (id: string) => {
    const host = await api.sdk.hosts.get({ hostId: id });
    const providers = await api.sdk.hosts.experimental_listProviders();
    if (!host.machineProviderId || !providers.some(p => p.id === host.machineProviderId))
      throw new Error("Machine has no registered provider");
    await api.sdk.hosts.delete({ hostId: id });
  };
  return {
    async readLedger() {
      const [hosts, providers, records, projects] = await Promise.all([
        api.sdk.hosts.list(), api.sdk.hosts.experimental_listProviders(), jobs(), api.sdk.projects.list(),
      ]);
      const repositories = await api.storage.kv.get<string[]>("dispatch.repositories") ??
        [...new Set(projects.flatMap(project => project.sources.map(source => source.path)))];
      const features = (await Promise.all(repositories.map(repository =>
        api.sdk.plugins.callRpc({ pluginId: "hyperfide-spec", method: "features",
          input: { repository }, outputSchema: featuresSchema }),
      ))).flat();
      const tasks = features.flatMap(feature => feature.tasks.map(task => ({
        ...task, qualifiedId: `${feature.id}/${task.id}`,
      })));
      const budget = await (await store()).get("fleet.control") as { cap: number; maximum: number; paused: boolean } | undefined ??
        { cap: 0, maximum: 0, paused: false };
      const backoff = await (await store()).get("budget") as { until: number } | undefined;
      return {
        machines: hosts.filter(host => providers.some(p => p.id === host.machineProviderId)).map(host => ({
          id: host.id, provider: host.machineProviderId!, state: host.lifecycle.phase,
          job: records.find(job => job.machine === host.id && job.state === "running")?.id ?? null,
          createdAt: new Date(host.createdAt).toISOString(),
        })),
        jobs: records.map(job => ({
          id: job.id, task: tasks.find(task => task.qualifiedId === job.task ||
            (task.id === job.task && tasks.filter(other => other.id === job.task).length === 1))?.qualifiedId ?? job.task,
          state: job.state, attempt: job.attempt, worker: job.machine ?? null,
          started: null, finished: null, log: job.error ?? "",
        })),
        budget: { ...budget, inFlight: records.filter(job => job.state === "running").length,
          keys: new Set(records.map(job => job.keyId)).size,
          backoffUntil: backoff?.until ? new Date(backoff.until).toISOString() : null },
        timelines: [],
      };
    },
    async cancelJob(id) {
      const job = (await jobs()).find(job => job.id === id);
      if (!job) throw new Error("Unknown job");
      if (job.state !== "running" && job.state !== "claimed") return;
      await (await store()).put(`job:${id}`, { ...job, cancelled: true, state: "failed", error: "Cancelled by operator" });
      if (job.machine) await destroyMachine(job.machine);
    },
    destroyMachine,
    async setPaused(paused) {
      const budget = await (await store()).get("fleet.control") as object | undefined ?? { cap: 0, maximum: 0 };
      await (await store()).put("fleet.control", { ...budget, paused });
    },
    async setCap(cap) {
      const budget = await (await store()).get("fleet.control") as { cap: number; maximum: number; paused: boolean } | undefined ??
        { cap: 0, maximum: 0, paused: false };
      await (await store()).put("fleet.control", { ...budget, cap: Math.min(cap, budget.maximum) });
    },
  };
}

export function registerServerImageBuilder(api: HyperfidePluginApi) {
  let builder: ImageBuilder | undefined;
  api.rpc.register(imageBuilderContract, {
    async imageBuilds() {
      const keys = await api.storage.kv.list("image-build/");
      return (await Promise.all(keys.map(key => api.storage.kv.get<BuildRecord>(key))))
        .filter((record): record is BuildRecord => record !== undefined);
    },
    async imageBuildStart({ commit }) {
      const providers = await api.sdk.hosts.experimental_listProviders();
      if (!providers.length) throw new Error("Configure a machine provider before building an image");
      if (!builder) {
        const repository = await api.storage.kv.get<string>("dispatch.repository");
        const fleetPath = await api.storage.kv.get<string>("dispatch.fleetPath");
        if (!repository || !fleetPath)
          throw new Error("Configure dispatch.repository and dispatch.fleetPath before building an image");
        builder = new ImageBuilder({
          repository, fleetPath, storage: api.storage.kv,
          machines: {
            // The registered lifecycle has no checkpoint operation yet.
            capabilities: { checkpoint: false, list: true },
            async create() { throw new Error("Registered machine providers do not support image checkpoints"); },
          },
        });
      }
      return builder.start(commit);
    },
    async imageBuildCancel({ id }) {
      const record = await api.storage.kv.get<BuildRecord>(`image-build/${id}`);
      if (!record) throw new Error("Unknown build");
      if (builder?.list().some(build => build.id === id)) await builder.cancel(id);
      else if (record.status === "running") throw new Error("Image build was interrupted before this server started");
      return null;
    },
  }, { experimental_discoverable: true, experimental_description: "Build fleet images" });
}
