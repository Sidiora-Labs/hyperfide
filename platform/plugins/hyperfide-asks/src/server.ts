import { z } from "zod";
import type { BbPluginApi } from "@hyperfide/plugin-sdk";
import { BinaryAskBridge, type AskBridge } from "./bridge-projection.js";
import { InboxService } from "./inbox.js";
import { inboxContract } from "./contract.js";
import { createThreadAskLifecycle } from "../../../packages/plugin-sdk/src/thread-ask-lifecycle.js";
import { AskTaskFlags } from "../../hyperfide-spec/src/ask-task-flags.js";
import { AskThreadLifecycle } from "./thread-lifecycle.js";
import type { AskBridge as ThreadAskBridge, TaskThreads } from "./task-3-2-projection.js";

export function registerInbox(api: BbPluginApi, bridge: AskBridge) {
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
export default async function plugin(api: BbPluginApi) {
  const repositories = await api.storage.kv.get<string[]>("inbox.repositories");
  const bridge: AskBridge = {
    async list() {
      const paths =
        repositories ??
        (await api.sdk.projects.list()).flatMap((project) =>
          project.sources.map((source) => source.path),
        );
      return new BinaryAskBridge([...new Set(paths)]).list();
    },
    async answer(ask, value, note) {
      await new BinaryAskBridge([ask.repository]).answer(ask, value, note);
    },
  };
  registerInbox(api, bridge);
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
      args.repository, args.bridge, args.threads, createThreadAskLifecycle(args.operations), board,
    ),
  };
}
