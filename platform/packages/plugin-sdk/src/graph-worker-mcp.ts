import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  WorkerCapability,
  WorkerMcpContext,
} from "@hyperfide/provider-bridge-protocol";

export const WORKER_SKILL =
  "Before editing, survey the area, then context for the files. Use the codify MCP survey and get_context tools (or hyperfide survey and hyperfide context). Cite file and line for claims and changes.";

export function graphRepository(cwd: string): string | null {
  let directory = resolve(cwd);
  for (;;) {
    try {
      if (statSync(join(directory, ".codegraph")).isDirectory()) return directory;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function graphWorkerMcp(context: WorkerMcpContext): WorkerCapability | null {
  const repository = graphRepository(context.cwd);
  if (repository === null) return null;
  try {
    const setting: unknown = JSON.parse(
      readFileSync(join(repository, ".codegraph", "worker-injection.json"), "utf8"),
    );
    if (
      typeof setting !== "object" ||
      setting === null ||
      !("enabled" in setting) ||
      typeof setting.enabled !== "boolean"
    ) {
      throw new Error("worker-injection.json must contain a boolean enabled setting");
    }
    if (!setting.enabled) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    id: "hyperfide-worker",
    label: "Hyperfide graph worker",
    instructions: WORKER_SKILL,
    mcpServers: {
      codify: {
        command: "hyperfide",
        args: ["mcp"],
        env: context.task ? { CG_TASK: context.task } : {},
      },
    },
  };
}
