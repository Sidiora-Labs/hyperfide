import { taskPacket } from "./shared/packet.js";
import type { WorkerProjectionAdapter } from "./worker-projection-adapter.js";

export interface RunTaskInput {
  repository: string;
  projectId: string;
  feature: string;
  task: string;
  providerId: string;
  environmentProviderId?: string;
}

export function createTaskWorker(adapter: WorkerProjectionAdapter) {
  const running = new Set<string>();
  return {
    async runTask(input: RunTaskInput) {
      for (const value of [input.feature, input.task]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new Error("Invalid task identity");
      }
      if (!input.providerId) throw new Error("A worker provider is required");
      const key = `${input.repository}:${input.feature}/${input.task}`;
      if (running.has(key)) throw new Error("Task already has a running worker");
      running.add(key);
      try {
        const task = await adapter.readTask(input.repository, input.feature, input.task);
        if (task.status === "implemented" || task.status === "done") {
          throw new Error("Task is already implemented");
        }
        let preamble = "";
        try {
          preamble = await adapter.readFile(input.repository, ".hyperfide/packet-preamble.md");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const thread = await adapter.spawn({
          repository: input.repository,
          projectId: input.projectId,
          providerId: input.providerId,
          environment: { type: "provider", environmentProviderId: input.environmentProviderId ?? "environment-git-worktree" },
          env: { CG_TASK: input.task },
          title: `${input.feature}/${input.task}: ${task.title}`,
          prompt: taskPacket(input.feature, input.task, task,
            await adapter.baseCommit(input.repository), preamble),
          origin: "plugin",
          originPluginId: "hyperfide-spec",
        });
        let reconciling = false;
        const unsubscribe = adapter.onStopped(thread.id, async () => {
          if (reconciling) return;
          reconciling = true;
          try {
            let status = "needs-review";
            try {
              const result = await adapter.readTask(thread.environment, input.feature, input.task);
              if (result.status === "implemented" || result.status === "done") status = result.status;
            } catch {
              // A missing/unreadable worker spec cannot attest implementation.
            }
            await adapter.publish({ feature: input.feature, task: input.task, threadId: thread.id, status });
            running.delete(key);
            unsubscribe();
          } finally {
            reconciling = false;
          }
        });
        return thread;
      } catch (error) {
        running.delete(key);
        throw error;
      }
    },
  };
}
