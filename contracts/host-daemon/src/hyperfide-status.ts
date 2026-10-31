import { z } from "zod";

export const hyperfideStatusSchema = z.object({
  path: z.string().nullable(),
  version: z.string().nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  ok: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
  repository: z.string(),
  index: z.record(z.string(), z.unknown()).nullable(),
}).strict();
export type HyperfideStatus = z.infer<typeof hyperfideStatusSchema>;
export const hyperfideStatusMessageSchema = z.object({
  type: z.literal("hyperfide.status"),
  status: hyperfideStatusSchema,
}).strict();
