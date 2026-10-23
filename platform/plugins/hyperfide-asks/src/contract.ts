import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";
export const askSchema = z.object({
  id: z.number(),
  repository: z.string(),
  task: z.string(),
  kind: z.enum(["secret", "variable", "permission", "decision", "question"]),
  question: z.string(),
  options: z.array(z.string()).default([]),
  recommendation: z.string().default(""),
  status: z.string(),
  deadline: z.union([z.string(), z.number()]).nullish(),
  sensitive: z.boolean().optional(),
});
export const inboxContract = defineRpcContract({
  inboxList: {
    input: z.object({
      kind: z.string().optional(),
      task: z.string().optional(),
    }),
    output: z.array(askSchema),
  },
  inboxAnswer: {
    input: z.object({
      repository: z.string(),
      id: z.number(),
      value: z.string().min(1),
      note: z.string().optional(),
      operator: z.string().optional(),
      sensitive: z.boolean().optional(),
    }),
    output: z.object({
      id: z.number(),
      repository: z.string(),
      answer: z.string(),
      note: z.string(),
      operator: z.string().optional(),
    }),
  },
});
