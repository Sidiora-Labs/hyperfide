import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0"));
export const scopeSchema = z
  .object({ hostId: text, repository: text })
  .strict();
export const requestSchema = scopeSchema
  .extend({
    command: z.enum(["survey", "context", "index-status", "why"]),
    target: text.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.command !== "index-status" && (!v.target || v.target.startsWith("-")))
      ctx.addIssue({
        code: "custom",
        message: "A non-option target is required",
      });
  });
export const settingsSchema = z
  .object({ enabled: z.boolean(), binaryPath: text.optional() })
  .strict();
export const binarySchema = z.object({
  path: text,
  version: text,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  ok: z.literal(true),
});
export const resultSchema = z
  .object({ binary: binarySchema, data: z.record(z.string(), z.unknown()) })
  .strict();
export const hostInputSchema = requestSchema.safeExtend({
  binaryPath: text.optional(),
  timeoutMs: z.number().int().min(1).max(60000),
});
export const graphHostContract = defineRpcContract({
  run: { input: hostInputSchema, output: resultSchema },
});
export const graphRpcContract = defineRpcContract({
  languageServerStatus: { input: scopeSchema, output: z.enum(["running", "stopped"]) },
  run: { input: requestSchema, output: resultSchema },
  getSettings: { input: scopeSchema, output: settingsSchema },
  setSettings: {
    input: scopeSchema.extend({ settings: settingsSchema }).strict(),
    output: settingsSchema,
  },
});
export type GraphRequest = z.infer<typeof requestSchema>;
export type GraphResult = z.infer<typeof resultSchema>;
