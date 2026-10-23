import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
export const manifestSchema = z.object({
  kind: z.literal("hyperfide.workspace-slice"),
  mode: z.enum(["SLICE", "FULL_TREE"]),
  fallback_reason: z.string().nullable(),
  digest: z.string().min(1),
  included_paths: z.array(z.string()),
  build_roots: z.array(z.string()),
  metadata_roots: z.array(z.string()),
});
export const sliceInputs = z.object({
  task: z.string().min(1),
  manifest: manifestSchema,
  snapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const id = z.object({ sliceId: z.string().regex(/^[a-f0-9]{64}$/) });
export const detailSchema = z.object({
  sliceId: z.string(),
  snapshotChain: z.array(z.string()),
  fallbackReason: z.string().nullable(),
});
export const slicesHostContract = defineRpcContract({
  create: {
    input: sliceInputs.extend({ repository: z.string(), thread: z.string() }),
    output: z.object({ sliceId: z.string(), path: z.string() }),
  },
  finish: { input: id, output: detailSchema },
  detail: { input: id, output: detailSchema },
  discard: { input: id, output: z.object({ removed: z.boolean() }) },
});
export const slicesRpcContract = defineRpcContract({
  detail: {
    input: z.object({ threadId: z.string() }),
    output: detailSchema.nullable(),
  },
});
