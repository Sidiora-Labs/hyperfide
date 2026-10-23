import { z } from "zod";

// Projection of 1.3: the graph/daemon owns binary resolution and host execution.
// Replace this interface with the graph plugin client when 1.3 merges.
export interface GraphMemoryHost {
  binaryPath(repository: string): Promise<string>;
  execute(input: {
    binary: string;
    repository: string;
    args: string[];
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

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

export class GraphMemoryBridge {
  constructor(private readonly host: GraphMemoryHost) {}

  private async run(scope: TaskScope, args: string[]): Promise<unknown> {
    taskScopeSchema.parse(scope);
    const binary = await this.host.binaryPath(scope.repository);
    if (!binary) throw new Error("Hyperfide binary is not configured on this host");
    const result = await this.host.execute({
      binary, repository: scope.repository, args: [...args, "--json"], timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Hyperfide memory command failed (${result.exitCode}): ${result.stderr}`);
    }
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
