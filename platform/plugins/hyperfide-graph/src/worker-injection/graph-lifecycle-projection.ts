// projection of task 1.3: replaced at merge
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  WorkerCapability,
  WorkerMcpContext,
} from "../../../../packages/provider-bridge-protocol/src/worker-mcp.js";
import { graphRepository, graphWorkerMcp } from "./worker-injection.js";

export interface GraphWorkerHost {
  threadContext(threadId: string): WorkerMcpContext;
  registerThreadInfo(id: string, read: (threadId: string) => WorkerCapability[]): void;
  registerRepositorySetting(id: string, set: (cwd: string, enabled: boolean) => void): void;
}

export function registerGraphWorker(host: GraphWorkerHost): void {
  host.registerThreadInfo("hyperfide-worker", (threadId) => {
    const capability = graphWorkerMcp(host.threadContext(threadId));
    return capability ? [capability] : [];
  });
  host.registerRepositorySetting("hyperfide-worker", (cwd, enabled) => {
    const repository = graphRepository(cwd);
    if (!repository) throw new Error("Repository has no .codegraph directory");
    writeFileSync(
      join(repository, ".codegraph", "worker-injection.json"),
      JSON.stringify({ enabled }) + "\n",
    );
  });
}
