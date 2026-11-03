import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  SourceMetrics,
  type SourceMetricAction,
} from "../../core/host-daemon/src/source-control/metrics.js";
import {
  sourceBindingSchema,
  sourceContract,
  sourceHostContract,
  type SourceActionInput,
} from "./contract.js";
import { executeSourceAction, loadSourceClient } from "./runtime.js";

function metricAction(action: SourceActionInput): SourceMetricAction {
  if (
    action.kind === "open" ||
    action.kind === "checkpoint" ||
    action.kind === "submit" ||
    action.kind === "qualify" ||
    action.kind === "accept"
  )
    return action.kind;
  if (action.kind === "merge" || action.kind === "resolve-conflict")
    return "transform";
  if (action.kind === "publish") return "publish";
  if (
    action.kind === "resume-publication" ||
    action.kind === "operation" ||
    action.kind === "complete-transfer"
  )
    return "resume";
  if (
    action.kind === "cancel-publication" ||
    action.kind === "cancel-operation" ||
    action.kind === "cancel-transfer"
  )
    return "cancel";
  return "read";
}
export default async function sourcePlugin(api: HyperfidePluginApi) {
  const settings = api.settings.define({
    projects: {
      type: "string",
      label: "Native source projects",
      description:
        "JSON array of projectId, protected configFile, and optional named revisions. Credentials remain in files on the server.",
      experimental_multiline: true,
      default: "[]",
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  const bindings = () => {
    const value = JSON.parse(current.projects) as unknown;
    if (!Array.isArray(value) || value.length > 64)
      throw new Error("Configure at most 64 native source projects");
    const parsed = value.map((item) => sourceBindingSchema.parse(item));
    if (new Set(parsed.map((item) => item.projectId)).size !== parsed.length)
      throw new Error("Native source project bindings must be unique");
    return parsed;
  };
  const nativeRpc = <T>(
    method: string,
    input: Record<string, string>,
    outputSchema: import("zod").ZodType<T>,
  ) =>
    api.sdk.plugins.callRpc({
      pluginId: "hyperfide-environment-slices",
      method,
      input,
      outputSchema,
    });
  const selectBinding = async (projectId: string) => {
    const project = (await api.sdk.projects.list()).find(
      (item) => item.id === projectId,
    );
    const binding = bindings().find((item) => item.projectId === project?.id);
    if (!binding)
      throw new Error("This project has no native source connection");
    return binding;
  };
  const hostBinding = async (projectId: string) => {
    const binding = await selectBinding(projectId);
    if (!binding.hostId || !binding.hostConfigFile)
      throw new Error(
        "Configure an enrolled host and its protected source connection path for this project",
      );
    return {
      ...binding,
      hostId: binding.hostId,
      hostConfigFile: binding.hostConfigFile,
    };
  };
  const mountKey = (projectId: string, workspaceId: string) =>
    `source-mount:${projectId}:${workspaceId}`;
  const metrics = new SourceMetrics();
  api.rpc.register(sourceContract, {
    hostCapabilities: async ({ projectId }) => {
      const binding = await selectBinding(projectId);
      if (!binding.hostId || !binding.hostConfigFile)
        return { configured: false };
      const known = (await api.sdk.hosts.list()).find(
        (item) => item.id === binding.hostId,
      );
      if (!known) throw new Error("The configured source host is not enrolled");
      return {
        configured: true,
        hostName: known.name ?? known.id,
        capabilities: await nativeRpc(
          "nativeCapabilities",
          { hostId: binding.hostId },
          sourceHostContract.capabilities.output,
        ),
      };
    },
    attach: async ({ projectId, workspaceId, mode }) => {
      const binding = await hostBinding(projectId);
      const connection = await loadSourceClient(binding.configFile);
      const value = await connection.client.call<{
        workspace: { mode: string };
      }>(
        "source.workspaces.detail",
        { workspace_id: workspaceId },
        connection.authority ? { authority: connection.authority } : {},
      );
      if (value.workspace.mode !== mode)
        throw new Error("Host mode must match the admitted workspace");
      const result = await nativeRpc(
        "nativeAttach",
        {
          projectId,
          hostId: binding.hostId,
          sourceConfigFile: binding.hostConfigFile,
          workspaceId,
          mode,
        },
        sourceHostContract.attach.output,
      );
      await api.storage.kv.set(mountKey(projectId, workspaceId), {
        ...result,
        hostId: binding.hostId,
        workspaceId,
      });
      return result;
    },
    hostMetrics: async ({ projectId, workspaceId }) => {
      const binding = await hostBinding(projectId);
      const mount = await api.storage.kv.get<{
        sliceId: string;
        hostId: string;
        workspaceId: string;
      }>(mountKey(projectId, workspaceId));
      if (
        !mount ||
        mount.hostId !== binding.hostId ||
        mount.workspaceId !== workspaceId
      )
        throw new Error("Attach this workspace before reading host metrics");
      const connection = await loadSourceClient(binding.configFile);
      await connection.client.call(
        "source.workspaces.detail",
        { workspace_id: workspaceId },
        connection.authority ? { authority: connection.authority } : {},
      );
      return nativeRpc(
        "nativeMetrics",
        { projectId, workspaceId },
        sourceHostContract.metrics.output,
      );
    },
    checkpointHost: async ({ projectId, workspaceId }) => {
      const binding = await hostBinding(projectId);
      const mount = await api.storage.kv.get<{
        sliceId: string;
        hostId: string;
        workspaceId: string;
      }>(mountKey(projectId, workspaceId));
      if (
        !mount ||
        mount.hostId !== binding.hostId ||
        mount.workspaceId !== workspaceId
      )
        throw new Error(
          "Attach this workspace before checkpointing host files",
        );
      const connection = await loadSourceClient(binding.configFile);
      await connection.client.call(
        "source.workspaces.detail",
        { workspace_id: workspaceId },
        connection.authority ? { authority: connection.authority } : {},
      );
      return nativeRpc(
        "nativeCheckpoint",
        { projectId, workspaceId },
        sourceHostContract.checkpoint.output,
      );
    },

    projects: async () => {
      const configured = bindings();
      const projects = await api.sdk.projects.list();
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        configured: configured.some((item) => item.projectId === project.id),
        revisions:
          configured.find((item) => item.projectId === project.id)?.revisions ??
          [],
        assignments:
          configured.find((item) => item.projectId === project.id)
            ?.assignments ?? [],
      }));
    },
    execute: async (request) => {
      const project = (await api.sdk.projects.list()).find(
        (project) => project.id === request.projectId,
      );
      const binding = bindings().find((item) => item.projectId === project?.id);
      if (!binding)
        throw new Error(
          "This project has no native source connection. Configure it in Source control settings.",
        );
      const action = metricAction(request.action),
        started = performance.now();
      let release: () => void;
      try {
        release = metrics.admit(action);
      } catch (error) {
        return {
          ok: false as const,
          operationId: request.operationId,
          error: {
            code: "OVERLOADED",
            message: (error as Error).message,
            retry: "RETRY_SAME_OPERATION",
            outcome: "KNOWN",
          },
        };
      }
      try {
        let connection: Awaited<ReturnType<typeof loadSourceClient>>;
        try {
          connection = await loadSourceClient(binding.configFile);
        } catch {
          metrics.record(action, "rejected", performance.now() - started);
          return {
            ok: false as const,
            operationId: request.operationId,
            error: {
              code: "CONFIGURATION_INVALID",
              message:
                "The configured source connection is unavailable. Check the protected configuration and credential files.",
              retry: "NEVER",
              outcome: "KNOWN",
            },
          };
        }
        const result = await executeSourceAction(
          connection,
          request.operationId,
          request.action,
        );
        metrics.record(
          action,
          result.ok
            ? "success"
            : result.error.outcome === "UNKNOWN"
              ? "unknown"
              : "rejected",
          performance.now() - started,
          request.action.kind === "checkpoint" && result.ok
            ? Buffer.byteLength(request.action.content)
            : 0,
        );
        return result;
      } finally {
        release();
      }
    },
    metrics: async ({ projectId }) => {
      const binding = await selectBinding(projectId);
      const connection = await loadSourceClient(binding.configFile);
      return {
        requests: metrics.snapshot(),
        source: await connection.client.call(
          "source.metrics.read",
          { max_rows: 1024 },
          connection.authority ? { authority: connection.authority } : {},
        ),
      };
    },
  });
}
