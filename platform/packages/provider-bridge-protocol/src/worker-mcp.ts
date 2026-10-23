import { z } from "zod";

export const workerCapabilitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  instructions: z.string().min(1),
  mcpServers: z.record(
    z.string(),
    z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()),
    }),
  ),
});

export type WorkerCapability = z.infer<typeof workerCapabilitySchema>;
export interface WorkerMcpContext {
  cwd: string;
  threadId: string;
  task?: string;
}
export type WorkerMcpHook = (
  context: WorkerMcpContext,
) => WorkerCapability | null;

export function resolveWorkerMcp(
  context: WorkerMcpContext,
  hook: WorkerMcpHook,
) {
  const capability = hook(context);
  return capability === null ? null : workerCapabilitySchema.parse(capability);
}
