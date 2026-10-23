import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectHyperfide } from "../../apps/host-daemon/src/hyperfide-status.js";
import { z } from "zod";

export const durableMemorySchema = z.object({
  id: z.number().int(),
  created: z.number(),
  type: z.enum(["decision", "constraint", "outcome", "preference", "fact"]),
  task: z.string().nullable(),
  body: z.string(),
});
export type DurableMemory = z.infer<typeof durableMemorySchema>;
export const taskScopeSchema = z.object({
  repository: z.string().min(1),
  task: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
});
export type TaskScope = z.infer<typeof taskScopeSchema>;

export class DurableMemoryBridge {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async run(scope: TaskScope, args: string[]): Promise<unknown> {
    taskScopeSchema.parse(scope);
    const binary = await inspectHyperfide(scope.repository, this.env);
    if (!binary.ok || !binary.path) throw new Error("Hyperfide binary is not configured on this host");
    const result = await promisify(execFile)(binary.path, [...args, "--json"], {
      cwd: scope.repository, env: this.env, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  }

  async remember(scope: TaskScope, body: string, type: "decision" | "constraint" = "decision") {
    z.string().trim().min(1).parse(body);
    z.enum(["decision", "constraint"]).parse(type);
    return z.object({
      id: z.number().int().nullable(), type: z.string(), task: z.string(),
      queued: z.boolean().optional(),
    }).parse(await this.run(scope, ["remember", body, "--type", type, "--task", scope.task]));
  }

  async recall(scope: TaskScope): Promise<DurableMemory[]> {
    // Query each type separately so unrelated facts cannot consume the result limit.
    const memories: DurableMemory[] = [];
    for (const type of ["decision", "constraint"] as const) {
      const result = z.object({ memories: z.array(durableMemorySchema) }).parse(
        await this.run(scope, ["recall", "--task", scope.task, "--type", type, "-n", "1000"]),
      );
      memories.push(...result.memories.filter(memory => memory.task === scope.task && memory.type === type));
    }
    return memories;
  }
}
