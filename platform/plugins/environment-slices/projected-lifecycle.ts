// Local seam for tasks 2.3 and 4.4: replace these bindings with their task-run,
// task-detail and wave-publication services when those tasks merge.
import {
  SlicesProvider,
  providerId,
  type SliceManifest,
  type Publication,
} from "./provider.ts";

type Inputs = { task: string; manifest: SliceManifest; snapshot?: string };
export const sliceInputs = {
  "~standard": {
    version: 1 as const,
    vendor: "hyperfide",
    validate(
      value: unknown,
    ): { value: Inputs } | { issues: { message: string }[] } {
      if (!value || typeof value !== "object")
        return { issues: [{ message: "Slice inputs are required" }] };
      const input = value as Partial<Inputs>;
      const manifest = input.manifest;
      if (
        typeof input.task !== "string" ||
        !input.task ||
        (input.snapshot !== undefined &&
          !/^[a-f0-9]{64}$/.test(input.snapshot)) ||
        !manifest ||
        manifest.kind !== "hyperfide.workspace-slice" ||
        !["SLICE", "FULL_TREE"].includes(manifest.mode) ||
        typeof manifest.digest !== "string" ||
        !manifest.digest ||
        ![
          manifest.included_paths,
          manifest.build_roots,
          manifest.metadata_roots,
        ].every(
          (paths) =>
            Array.isArray(paths) &&
            paths.every((path) => typeof path === "string"),
        )
      ) {
        return {
          issues: [
            { message: "Expected a task and a Hyperfide slice manifest" },
          ],
        };
      }
      return { value: input as Inputs };
    },
  },
};
interface Registration {
  id: string;
  displayName: string;
  description: string;
  icon: string;
  requires: { projectCheckout: true };
  inputs: typeof sliceInputs;
  create(context: {
    projectCheckout: { path: string };
    thread: { id: string };
    inputs: Inputs;
    pathKey: string;
  }): Promise<{
    status: "created";
    path: string;
    ownsPath: true;
    resource: { sliceId: string };
  }>;
  remove(context: { resource: unknown }): Promise<{ status: "removed" }>;
}
export interface TaskLifecycle {
  experimental_environments: { register(provider: Registration): void };
  onThreadFinished(handler: (sliceId: string) => Promise<void>): void;
  registerTaskDetail(
    id: string,
    render: (
      sliceId: string,
    ) => Promise<{
      sliceId: string;
      snapshotChain: string[];
      fallbackReason: string | null;
    }>,
  ): void;
  registerPublication(
    id: string,
    publish: (sliceId: string, worktree: string) => Promise<void>,
  ): void;
}
export function registerSlices(
  lifecycle: TaskLifecycle,
  service: SlicesProvider,
  publication: Publication,
) {
  lifecycle.experimental_environments.register({
    id: providerId,
    displayName: "Snapshot slice",
    description: "Edit a task slice in its own snapshot chain.",
    icon: "Layers",
    requires: { projectCheckout: true },
    inputs: sliceInputs,
    async create(context) {
      const state = await service.create({
        ...context.inputs,
        repository: context.projectCheckout.path,
        thread: `${context.thread.id}:${context.pathKey}`,
      });
      return {
        status: "created",
        path: state.path,
        ownsPath: true,
        resource: { sliceId: state.id },
      };
    },
    async remove({ resource }) {
      if (resource !== null) {
        if (
          !resource ||
          typeof resource !== "object" ||
          !("sliceId" in resource) ||
          typeof resource.sliceId !== "string"
        )
          throw new Error("Invalid slice resource");
        await service.discard(resource.sliceId);
      }
      return { status: "removed" };
    },
  });
  lifecycle.onThreadFinished(async (id) => {
    await service.finish(id);
  });
  lifecycle.registerTaskDetail(providerId, async (id) => {
    const state = await service.load(id);
    return {
      sliceId: state.id,
      snapshotChain: state.snapshots,
      fallbackReason: state.manifest.fallback_reason,
    };
  });
  lifecycle.registerPublication(providerId, (id, worktree) =>
    service.publish(id, worktree, publication),
  );
}
