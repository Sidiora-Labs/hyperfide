import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
const status = z.object({
  configured: z.boolean(),
  verifiedAt: z.string().nullable(),
  projectName: z.string().nullable(),
  environmentName: z.string().nullable(),
  region: z.string().nullable(),
  sandboxCount: z.number().nullable(),
  machineCount: z.number(),
  machines: z.array(z.object({ phase: z.string() })),
  bootstrap: z.object({
    phase: z.string(),
    updatedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }),
  lastError: z.string().nullable(),
});
export type RailwayStatus = z.infer<typeof status>;
export const railwayContract = defineRpcContract({
  railwayStatus: { input: z.object({}).nullish(), output: status },
  railwayVerify: { input: z.object({}).nullish(), output: status },
});
