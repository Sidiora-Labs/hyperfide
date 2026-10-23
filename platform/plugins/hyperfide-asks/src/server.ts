import { AskBridge as StoreBridge } from "./bridge.js";
import { settingsSchema } from "../../hyperfide-graph/contract.js";
import { localGraphHost } from "./graph-host.js";
import { bridgeContract } from "./bridge-contract.js";
import { z } from "zod";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { BinaryAskBridge, type AskBridge } from "./inbox-adapter.js";
import { InboxService } from "./inbox.js";
import { inboxContract } from "./contract.js";
import { createThreadAskLifecycle } from "@hyperfide/plugin-sdk/host";
import { AskTaskFlags } from "../../hyperfide-spec/src/ask-task-flags.js";
import { AskThreadLifecycle } from "./thread-lifecycle.js";
import type { TaskThreads } from "./thread-lifecycle.js";

export function registerInbox(api: HyperfidePluginApi, bridge: AskBridge) {
  const inbox = new InboxService(bridge, async (value) => {
    const result = await api.sdk.plugins.callRpc({
      pluginId: "hyperfide-secrets",
      method: "storeReference",
      input: { value },
      outputSchema: z.object({ name: z.string() }),
    });
    if (!/^ask-[a-f0-9-]+$/.test(result.name))
      throw new Error("Invalid secret reference");
    return result.name;
  });
  api.rpc.register(inboxContract, {
    inboxList: (input) => inbox.list(input),
    inboxAnswer: (input) => inbox.answer(input),
  });
}
export default async function plugin(api: HyperfidePluginApi) {
  const repositories =
    (await api.storage.kv.get<string[]>("inbox.repositories")) ??
    (await api.sdk.projects.list()).flatMap((project) =>
      project.sources.map((source) => source.path),
    );
  const paths = [...new Set(repositories)];
  const bridge = new StoreBridge(
    localGraphHost(async (repository, hostId) => {
      const settings = await api.sdk.plugins.callRpc({
        pluginId: "hyperfide-graph",
        method: "getSettings",
        input: { repository, hostId },
        outputSchema: settingsSchema,
      });
      if (!settings.enabled)
        throw new Error("Graph is disabled for this repository");
      return settings.binaryPath;
    }),
    (channel, payload) => api.realtime.publish(channel, payload),
  );
  const repositoryFor = (repository?: string) => {
    if (repository) return repository;
    if (paths.length !== 1) throw new Error("Repository is required");
    return paths[0]!;
  };
  api.rpc.register(bridgeContract, {
    context: async ({ threadId, projectId }) => {
      const thread = await api.sdk.threads.get({ threadId });
      if (thread.projectId !== projectId || thread.originPluginId !== "hyperfide-spec")
        throw new Error("Question requires a spec worker thread");
      // Spec workers are titled <feature>/<task>: <title> by runTask.
      const task = thread.title?.match(/^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+): /)?.[1];
      const project = (await api.sdk.projects.list()).find((entry) => entry.id === projectId);
      const sources = [...new Set(project?.sources.map((source) => source.path) ?? [])];
      if (!task || sources.length !== 1 || !paths.includes(sources[0]!))
        throw new Error("Question requires an unambiguous repository and task");
      return { repository: sources[0]!, task };
    },
    list: async ({ repository }) => ({
      asks: (
        await Promise.all(
          (repository ? [repository] : paths).map(async (path) =>
            (await bridge.list(path)).map((ask) => ({
              ...ask,
              repository: path,
            })),
          ),
        )
      ).flat(),
    }),
    get: ({ repository, id }) => bridge.get(repository, id),
    answer: ({ repository, id, answer, note }) =>
      bridge.answer(repository, id, answer, note),
    journal: ({ repository }) => bridge.journal(repository),
    policy: ({ repository }) => bridge.policy(repositoryFor(repository)),
  });
  registerInbox(api, new BinaryAskBridge(paths, bridge));
  for (const repository of paths) {
    try {
      api.onDispose(await bridge.watch(repository));
    } catch {
      api.realtime.publish("asks.error", {
        repository,
        message: "Ask watch unavailable",
      });
    }
  }
}

/** Composition point for the 3.1 bridge and 2.3 worker-thread registry. */
export function createAskThreadService(args: {
  repository: string;
  bridge: Pick<StoreBridge, "policy" | "list" | "watch">;
  threads: TaskThreads;
  operations: Parameters<typeof createThreadAskLifecycle>[0];
  board?: AskTaskFlags;
}) {
  const board = args.board ?? new AskTaskFlags();
  return {
    board,
    lifecycle: new AskThreadLifecycle(
      args.repository,
      args.bridge,
      args.threads,
      createThreadAskLifecycle(args.operations),
      board,
    ),
  };
}
