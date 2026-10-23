import { AskBridge as StoreBridge } from "./bridge.js";
import { localGraphHost } from "./graph-host-projection.js";
import { bridgeContract } from "./bridge-contract.js";
import { z } from "zod";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { BinaryAskBridge, type AskBridge } from "./bridge-projection.js";
import { InboxService } from "./inbox.js";
import { inboxContract } from "./contract.js";
import { createThreadAskLifecycle } from "../../../packages/plugin-sdk/src/thread-ask-lifecycle.js";
import { AskTaskFlags } from "../../hyperfide-spec/src/ask-task-flags.js";
import { AskThreadLifecycle } from "./thread-lifecycle.js";
import type {
  AskBridge as ThreadAskBridge,
  TaskThreads,
} from "./task-3-2-projection.js";

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
  const binary = await api.storage.kv.get<string>("graph.binaryPath");
  const bridge = new StoreBridge(localGraphHost(binary), (channel, payload) =>
    api.realtime.publish(channel, payload),
  );
  const repositoryFor = (repository?: string) => {
    if (repository) return repository;
    if (paths.length !== 1) throw new Error("Repository is required");
    return paths[0]!;
  };
  api.rpc.register(bridgeContract, {
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
  registerInbox(api, new BinaryAskBridge(paths, binary, bridge));
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
  bridge: ThreadAskBridge;
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
