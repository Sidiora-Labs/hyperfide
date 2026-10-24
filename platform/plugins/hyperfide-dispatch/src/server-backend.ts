import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FleetBackend } from "./fleet-view/rpc.js";
import type { JobLedger } from "./dispatcher/dispatcher.js";
import { openDispatchStorage, migrateDispatchDirectory } from "./storage.js";
import { imageBuilderContract } from "./image-builder/rpc.js";
import { ImageBuilder, type BuildRecord } from "./image-builder/builder.js";
import { dispatchSettings, registeredMachines, type DispatchSettings } from "./server-runtime.js";

const featuresSchema = z.array(
  z.object({
    id: z.string(),
    tasks: z.array(z.object({ id: z.string(), status: z.string() })),
  }),
);

export function createServerBackend(api: HyperfidePluginApi): FleetBackend {
  // Open lazily: the SDK and its registered providers are available after bind.
  let storage: ReturnType<typeof openDispatchStorage> | undefined;
  const store = () =>
    (storage ??= (async () => {
      const directory = join(
        api.server.experimental_dataDir,
        "plugins",
        api.pluginId,
      );
      await mkdir(directory, { recursive: true });
      const value = await openDispatchStorage(directory);
      await migrateDispatchDirectory(directory, value);
      if (!(await value.get("fleet.control")))
        await value.put("fleet.control", { cap: 0, maximum: 0, paused: true });
      return value;
    })());
  api.onDispose(async () => {
    if (storage) (await storage).close();
  });
  const jobs = async () =>
    (await (await store()).entries())
      .filter((entry) => entry.key.startsWith("job:"))
      .map((entry) => entry.value as JobLedger);
  const destroyMachine = async (id: string) => {
    const owner = await (await store()).get(`machine:${id}`);
    if (typeof owner === "string") {
      const operations = api.experimental_machines?.getSandboxProvider?.(owner);
      if (!operations) throw new Error("Machine provider unavailable");
      await (await operations.connect(id)).destroy();
      return;
    }
    for (const provider of await api.sdk.hosts.experimental_listProviders()) {
      const operations = api.experimental_machines?.getSandboxProvider?.(provider.id);
      if (operations?.capabilities.list && (await operations.list().catch(() => [])).some(machine => machine.id === id)) {
        await (await operations.connect(id)).destroy();
        return;
      }
    }
    const host = await api.sdk.hosts.get({ hostId: id });
    const providers = await api.sdk.hosts.experimental_listProviders();
    if (
      !host.machineProviderId ||
      !providers.some((p) => p.id === host.machineProviderId)
    )
      throw new Error("Machine has no registered provider");
    await api.sdk.hosts.delete({ hostId: id });
  };
  return {
    async readLedger() {
      const [hosts, providers, records, projects] = await Promise.all([
        api.sdk.hosts.list(),
        api.sdk.hosts.experimental_listProviders(),
        jobs(),
        api.sdk.projects.list(),
      ]);
      const repositories = (await api.storage.kv.get<string[]>(
        "dispatch.repositories",
      )) ?? [
        ...new Set(
          projects.flatMap((project) =>
            project.sources.map((source) => source.path),
          ),
        ),
      ];
      const features = (
        await Promise.all(
          repositories.map((repository) =>
            api.sdk.plugins.callRpc({
              pluginId: "hyperfide-spec",
              method: "features",
              input: { repository },
              outputSchema: featuresSchema,
            }),
          ),
        )
      ).flat();
      const tasks = features.flatMap((feature) =>
        feature.tasks.map((task) => ({
          ...task,
          qualifiedId: `${feature.id}/${task.id}`,
        })),
      );
      const budget = ((await (await store()).get("fleet.control")) as
        | { cap: number; maximum: number; paused: boolean }
        | undefined) ?? { cap: 0, maximum: 0, paused: true };
      const backoff = (await (await store()).get("budget")) as
        | { until: number }
        | undefined;
      const sandboxMachines = [];
      let capable = false;
      let unavailable = false;
      for (const provider of providers) {
        const operations = api.experimental_machines?.getSandboxProvider?.(provider.id);
        if (operations?.capabilities.checkpoint) capable = true;
        if (operations?.capabilities.list) {
          const listed = await operations.list().catch(() => { unavailable = true; return []; });
          for (const machine of listed) {
            if (hosts.some(host => host.id === machine.id)) continue;
            sandboxMachines.push({ id: machine.id, provider: provider.id, state: machine.status,
              job: records.find(job => job.machine === machine.id && job.state === "running")?.id ?? null,
              createdAt: machine.createdAt ?? new Date(0).toISOString() });
          }
        }
      }
      return {
        machines: [...sandboxMachines, ...hosts
          .filter((host) =>
            providers.some((p) => p.id === host.machineProviderId),
          )
          .map((host) => ({
            id: host.id,
            provider: host.machineProviderId!,
            state: host.lifecycle.phase,
            job:
              records.find(
                (job) => job.machine === host.id && job.state === "running",
              )?.id ?? null,
            createdAt: new Date(host.createdAt).toISOString(),
          }))],
        jobs: records.map((job) => ({
          id: job.id,
          task:
            tasks.find(
              (task) =>
                task.qualifiedId === job.task ||
                (task.id === job.task &&
                  tasks.filter((other) => other.id === job.task).length === 1),
            )?.qualifiedId ?? job.task,
          state: job.state,
          attempt: job.attempt,
          worker: job.worker ?? job.machine ?? null,
          started: job.started ?? null,
          finished: job.finished ?? null,
          log: job.log ?? job.error ?? "",
          source: job.source,
        })),
        budget: {
          ...budget,
          inFlight: records.filter((job) => job.state === "running").length,
          keys: (await (await store()).get("fleet.keys")) as number | undefined ?? new Set(records.map((job) => job.keyId)).size,
          status: `${budget.paused ? "Paused" : "Active"}; ${records.some((job) => job.state === "running") ? "running" : "idle"}; ${providers.length ? `${providers.length} providers registered${capable ? "" : "; no checkpoint-capable provider"}${unavailable ? "; provider unavailable: check configuration" : ""}` : "no providers configured"}`,
          backoffUntil: backoff?.until
            ? new Date(backoff.until).toISOString()
            : null,
        },
        timelines: [...new Set(records.map((job) => job.task))].map((task) => ({
          task,
          events: records
            .filter((job) => job.task === task)
            .flatMap((job) => job.events ?? [])
            .sort((a, b) => a.at.localeCompare(b.at)),
        })),
      };
    },
    async cancelJob(id) {
      const job = (await jobs()).find((job) => job.id === id);
      if (!job) throw new Error("Unknown job");
      if (job.state !== "running" && job.state !== "claimed") return;
      const finished = new Date().toISOString();
      await (
        await store()
      ).put(`job:${id}`, {
        ...job,
        cancelled: true,
        state: "failed",
        error: "Cancelled by operator",
        finished,
        events: [...(job.events ?? []), { stage: "failed", at: finished }],
      });
      if (job.machine) await destroyMachine(job.machine);
    },
    destroyMachine,
    async importLedgers({ source, jobs: records }) {
      const storage = await store();
      for (const job of records) {
        const previous = (await storage.get(`job:${job.id}`)) as
          | JobLedger
          | undefined;
        await storage.put(`job:${job.id}`, { ...previous, ...job, source });
      }
    },
    async setPaused(paused) {
      const budget = ((await (await store()).get("fleet.control")) as
        | object
        | undefined) ?? { cap: 0, maximum: 0 };
      await (await store()).put("fleet.control", { ...budget, paused });
    },
    async setCap(cap) {
      const budget = ((await (await store()).get("fleet.control")) as
        | { cap: number; maximum: number; paused: boolean }
        | undefined) ?? { cap: 0, maximum: 0, paused: true };
      await (
        await store()
      ).put("fleet.control", { ...budget, cap: Math.min(cap, budget.maximum) });
    },
  };
}

export function registerServerImageBuilder(api: HyperfidePluginApi, settings: DispatchSettings = dispatchSettings(api)) {
  let builder: ImageBuilder | undefined;
  api.onDispose(async () => {
    if (!builder) return;
    const jobs = builder.list().filter(job => job.status === "running");
    await Promise.all(jobs.map(async job => {
      await builder!.cancel(job.id);
      await builder!.wait(job.id);
    }));
  });
  api.rpc.register(
    imageBuilderContract,
    {
      async imageBuildConfiguration() {
        const values = await settings.get();
        const configured = !!(
          values.dispatch_repository && values.dispatch_fleetPath
        );
        const provider = await registeredMachines(api);
        return {
          configured: configured && !!provider,
          message: [
            ...(!configured ? ["Not configured: set Repository path and Fleet configuration path in Dispatch settings."] : []),
            ...(!provider ? ["No checkpoint-capable provider"] : []),
          ].join(" ") || "Ready",
        };
      },
      async imageBuilds() {
        const keys = await api.storage.kv.list("image-build/");
        return (
          await Promise.all(
            keys.map((key) => api.storage.kv.get<BuildRecord>(key)),
          )
        ).filter((record): record is BuildRecord => record !== undefined);
      },
      async imageBuildStart({ commit }) {
        const machines = await registeredMachines(api);
        if (!machines) throw new Error("no checkpoint-capable provider");
        if (!builder) {
          const values = await settings.get();
          const repository = values.dispatch_repository;
          const fleetPath = values.dispatch_fleetPath;
          if (!repository || !fleetPath)
            throw new Error(
              "Configure dispatch.repository and dispatch.fleetPath before building an image",
            );
          builder = new ImageBuilder({
            repository,
            fleetPath,
            storage: api.storage.kv,
            machines,
          });
        }
        return builder.start(commit);
      },
      async imageBuildCancel({ id }) {
        const record = await api.storage.kv.get<BuildRecord>(
          `image-build/${id}`,
        );
        if (!record) throw new Error("Unknown build");
        if (builder?.list().some((build) => build.id === id))
          await builder.cancel(id);
        else if (record.status === "running")
          throw new Error(
            "Image build was interrupted before this server started",
          );
        return null;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Build fleet images",
    },
  );
}
