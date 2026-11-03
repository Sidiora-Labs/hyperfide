import {
  experimental_PluginRpcRefusal,
  type HyperfidePluginApi,
} from "@hyperfide/plugin-sdk";
import {
  sliceInputs,
  nativeSliceInputs,
  nativeProviderId,
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
      native?: boolean;
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
  api.experimental_environments.register({
    id: nativeProviderId,
    displayName: "Native source workspace",
    description:
      "Open an admitted native source workspace with sparse or virtual files.",
    icon: "Layers",
    requires: { projectless: true },
    inputs: nativeSliceInputs,
    async create(context) {
      const state = await host.call(
        "createNative",
        {
          ...context.inputs,
          thread: `${context.thread.id}:${context.pathKey}`,
        },
        { hostId: context.host.id, signal: context.signal },
      );
      await api.storage.kv.set(key(context.thread.id), {
        sliceId: state.sliceId,
        hostId: context.host.id,
        native: true,
      });
      return {
        status: "created",
        path: state.path,
        ownsPath: true,
        resource: {
          sliceId: state.sliceId,
          threadId: context.thread.id,
          native: true,
        },
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
        typeof resource.threadId !== "string" ||
        resource.native !== true
      )
        throw new Error("Invalid native workspace resource");
      await host.call(
        "discardNative",
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
        saved.native ? "finishNative" : "finish",
        { sliceId: saved.sliceId },
        { hostId: saved.hostId },
      );
  });
  type NativeBinding = {
    projectId: string;
    workspaceId: string;
    hostId: string;
    sourceConfigFile: string;
    mode: "SPARSE" | "MATERIALIZED" | "VIRTUAL";
    sliceId: string;
  };
  type Caller = {
    experimental_caller:
      | { kind: "client" }
      | { kind: "plugin"; pluginId: string };
  };
  const nativeCaller = (context: Caller) => {
    if (
      context.experimental_caller.kind !== "plugin" ||
      context.experimental_caller.pluginId !== "hyperfide-source-control"
    )
      throw new experimental_PluginRpcRefusal({
        code: "forbidden",
        message: "Native source integration requires the source-control plugin",
      });
    return context.experimental_caller.pluginId;
  };
  const nativeKey = (
    caller: string,
    input: { projectId: string; workspaceId: string },
  ) => `native-plugin:${caller}:${input.projectId}:${input.workspaceId}`;
  const nativeBinding = async (
    context: Caller,
    input: { projectId: string; workspaceId: string },
  ) => {
    const caller = nativeCaller(context),
      saved = (await api.storage.kv.get(
        nativeKey(caller, input),
      )) as NativeBinding | null;
    if (
      !saved ||
      saved.projectId !== input.projectId ||
      saved.workspaceId !== input.workspaceId
    )
      throw new experimental_PluginRpcRefusal({
        code: "not_found",
        message: "Native workspace is not attached for this project",
      });
    return saved;
  };
  api.rpc.register(slicesRpcContract, {
    async nativeAttach(input, context) {
      const caller = nativeCaller(context),
        location = nativeKey(caller, input);
      const saved = (await api.storage.kv.get(
        location,
      )) as NativeBinding | null;
      if (
        saved &&
        (saved.hostId !== input.hostId ||
          saved.sourceConfigFile !== input.sourceConfigFile ||
          saved.mode !== input.mode)
      )
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message:
            "Native workspace attachment has another host or source configuration",
        });
      const result = await host.call(
        "createNative",
        {
          sourceConfigFile: input.sourceConfigFile,
          workspaceId: input.workspaceId,
          mode: input.mode,
          ...(input.readPaths ? { readPaths: input.readPaths } : {}),
          thread: `${caller}:${input.projectId}:${input.workspaceId}`,
        },
        { hostId: input.hostId },
      );
      if (saved && saved.sliceId !== result.sliceId)
        throw new experimental_PluginRpcRefusal({
          code: "conflict",
          message: "Native workspace attachment identity changed",
        });
      await api.storage.kv.set(location, {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        hostId: input.hostId,
        sourceConfigFile: input.sourceConfigFile,
        mode: input.mode,
        sliceId: result.sliceId,
      });
      return result;
    },
    async nativeMetrics(input, context) {
      const saved = await nativeBinding(context, input);
      return host.call(
        "metricsNative",
        { sliceId: saved.sliceId },
        { hostId: saved.hostId },
      );
    },
    async nativeCheckpoint(input, context) {
      const saved = await nativeBinding(context, input);
      return host.call(
        "finishNative",
        { sliceId: saved.sliceId },
        { hostId: saved.hostId },
      );
    },
    async nativeDetach(input, context) {
      const saved = await nativeBinding(context, input);
      return host.call(
        "detachNative",
        { sliceId: saved.sliceId },
        { hostId: saved.hostId },
      );
    },

    nativeCapabilities: ({ hostId }) =>
      host.call("nativeCapabilities", {}, { hostId }),
    async detail({ threadId }) {
      const saved = await binding(threadId);
      return saved
        ? host.call(
            saved.native ? "detailNative" : "detail",
            { sliceId: saved.sliceId },
            { hostId: saved.hostId },
          )
        : null;
    },
  });
}
