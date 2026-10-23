import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  sliceInputs,
  slicesHostContract,
  slicesRpcContract,
} from "./contract.ts";
import { providerId } from "./provider.ts";
export default function slicesPlugin(api: HyperfidePluginApi) {
  const host = api.hosts.experimental_client({ contract: slicesHostContract });
  const key = (thread: string) => `slice-thread:${thread}`;
  const binding = async (thread: string) =>
    (await api.storage.kv.get(key(thread))) as {
      sliceId: string;
      hostId: string;
    } | null;
  api.experimental_environments.register({
    id: providerId,
    displayName: "Snapshot slice",
    description: "Edit a task slice in its own snapshot chain.",
    icon: "Layers",
    requires: { projectCheckout: true },
    inputs: sliceInputs,
    async create(context) {
      const state = await host.call(
        "create",
        {
          ...context.inputs,
          repository: context.projectCheckout.path,
          thread: `${context.thread.id}:${context.pathKey}`,
        },
        { hostId: context.host.id, signal: context.signal },
      );
      await api.storage.kv.set(key(context.thread.id), {
        sliceId: state.sliceId,
        hostId: context.host.id,
      });
      return {
        status: "created",
        path: state.path,
        ownsPath: true,
        resource: { sliceId: state.sliceId, threadId: context.thread.id },
      };
    },
    async remove(context) {
      if (context.resource === null) return { status: "removed" };
      const resource = context.resource;
      if (
        !context.hostId ||
        typeof resource !== "object" ||
        Array.isArray(resource) ||
        typeof resource.sliceId !== "string" ||
        typeof resource.threadId !== "string"
      )
        throw new Error("Invalid slice resource");
      await host.call(
        "discard",
        { sliceId: resource.sliceId },
        { hostId: context.hostId, signal: context.signal },
      );
      await api.storage.kv.delete(key(resource.threadId));
      return { status: "removed" };
    },
  });
  api.events.on("thread.idle", async ({ thread }) => {
    const saved = await binding(thread.id);
    if (saved)
      await host.call(
        "finish",
        { sliceId: saved.sliceId },
        { hostId: saved.hostId },
      );
  });
  api.rpc.register(slicesRpcContract, {
    async detail({ threadId }) {
      const saved = await binding(threadId);
      return saved
        ? host.call(
            "detail",
            { sliceId: saved.sliceId },
            { hostId: saved.hostId },
          )
        : null;
    },
  });
}
