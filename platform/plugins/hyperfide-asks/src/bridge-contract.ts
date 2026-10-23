import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
const repository = z.string().min(1);
const id = z
  .union([z.string().min(1), z.number().int().positive()])
  .transform(String);
const row = z
  .object({
    id: z.union([z.string(), z.number()]),
    kind: z.string(),
    question: z.string(),
    status: z.string(),
  })
  .passthrough();
const input = z.object({ repository });
export const bridgeContract = defineRpcContract({
  list: {
    input: z.object({ repository: repository.optional() }),
    output: z.object({ asks: z.array(row) }),
  },
  get: { input: z.object({ repository, id }), output: row.nullable() },
  answer: {
    input: z.object({
      repository,
      id,
      answer: z.string().min(1),
      note: z.string().optional(),
    }),
    output: row.nullable(),
  },
  journal: { input, output: z.array(z.unknown()) },
  policy: {
    input: z.object({ repository: repository.optional() }),
    output: z.record(z.string(), z.enum(["block", "proceed-and-flag"])),
  },
});
