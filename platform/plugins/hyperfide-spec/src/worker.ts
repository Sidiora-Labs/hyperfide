import type { RunResult } from "./execution.js";
import { taskPacket } from "./shared/packet.js";
import { featureFromKvx } from "./kvx.js";
import type { Task } from "./shared/model.js";

export interface TaskWorkerHost {
  readFile(environment: string, path: string): Promise<string>;
  baseCommit(repository: string): Promise<string>;
  spawn(request: WorkerThreadRequest): Promise<{ id: string; environment: string }>;
  // Subscribe with replay if the thread stopped before subscription completed.
  // Deliver callbacks asynchronously, and await them so reconciliation can retry.
  onStopped(threadId: string, callback: () => Promise<void>): () => void;
  publish(update: WorkerTaskUpdate): Promise<void>;
}

export interface WorkerThreadRequest {
  repository: string;
  projectId: string;
  providerId: string;
  environment: { type: "provider"; environmentProviderId: string };
  env: { CG_TASK: string };
  title: string;
  prompt: string;
  tools?: { verify(): Promise<RunResult> };
  origin: "plugin";
  originPluginId: "hyperfide-spec";
}

export interface WorkerTaskUpdate {
  feature: string;
  task: string;
  threadId: string;
  status: string;
  repository?: string;
  environment?: string;
  projectId?: string;
  providerId?: string;
  base?: string;
}

export interface RunTaskInput {
  repository: string;
  projectId: string;
  feature: string;
  task: string;
  providerId: string;
  environmentProviderId?: string;
}

export function spawnTaskThread(host: TaskWorkerHost, request: WorkerThreadRequest) {
  return host.spawn(request);
}

export function createTaskWorker(adapter: TaskWorkerHost) {
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
        const task = await readWorkerTask(adapter, input.repository, input.feature, input.task);
        if (task.status === "implemented" || task.status === "done") {
          throw new Error("Task is already implemented");
        }
        let preamble = "";
        try {
          preamble = await adapter.readFile(input.repository, ".hyperfide/packet-preamble.md");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const base = await adapter.baseCommit(input.repository);
        const thread = await spawnTaskThread(adapter, {
          repository: input.repository,
          projectId: input.projectId,
          providerId: input.providerId,
          environment: { type: "provider", environmentProviderId: input.environmentProviderId ?? "environment-git-worktree" },
          env: { CG_TASK: input.task },
          title: `${input.feature}/${input.task}: ${task.title}`,
          prompt: taskPacket(input.feature, input.task, task,
            base, preamble),
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
              const result = await readWorkerTask(adapter, thread.environment, input.feature, input.task);
              if (result.status === "implemented" || result.status === "done") status = result.status;
            } catch {
              // A missing/unreadable worker spec cannot attest implementation.
            }
            await adapter.publish({ feature: input.feature, task: input.task, threadId: thread.id, status, repository: input.repository,
              environment: thread.environment, projectId: input.projectId, providerId: input.providerId, base });
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

/** Read the same task model used by the board, scoped to the worker checkout. */
export async function readWorkerTask(host: Pick<TaskWorkerHost, "readFile">,
  environment: string, feature: string, id: string): Promise<Task> {
  const model = featureFromKvx(feature, await host.readFile(environment, `spec/${feature}/spec.kvx`));
  const task = model.tasks.find(task => task.id === id);
  if (!task) throw new Error(`Unknown task ${feature}/${id}`);
  return task;
}
