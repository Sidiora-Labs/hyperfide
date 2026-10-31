import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";

export const stages = [
  "created",
  "prepared",
  "running",
  "packed",
  "collected",
  "merged",
  "claimed",
  "started",
  "finished",
  "failed",
] as const;
const timestamp = z.string().datetime();
export const ledgerSchema = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      state: z.string(),
      job: z.string().nullable(),
      createdAt: timestamp,
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string(),
      task: z.string(),
      state: z.string(),
      attempt: z.number().int(),
      worker: z.string().nullable(),
      started: timestamp.nullable(),
      finished: timestamp.nullable(),
      log: z.string(),
      source: z.string().optional(),
    }),
  ),
  budget: z.object({
    cap: z.number().int().nonnegative(),
    maximum: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    keys: z.number().int().nonnegative(),
    backoffUntil: timestamp.nullable(),
    paused: z.boolean(),
    status: z.string().optional(),
  }),
  timelines: z.array(
    z.object({
      task: z.string(),
      events: z.array(z.object({ stage: z.enum(stages), at: timestamp })),
    }),
  ),
});
export type FleetLedger = z.infer<typeof ledgerSchema>;
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel"), id: z.string().min(1) }),
  z.object({ kind: z.literal("destroy"), id: z.string().min(1) }),
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({
    kind: z.literal("raiseCap"),
    cap: z.number().int().nonnegative(),
  }),
]);
export type FleetAction = z.infer<typeof actionSchema>;
export const importLedgersSchema = z.object({
  source: z.string().min(1),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      task: z.string().min(1),
      state: z.enum(["claimed", "running", "succeeded", "failed"]),
      attempt: z.number().int().nonnegative(),
      keyId: z.string(),
      commits: z.array(z.string()),
      machine: z.string().optional(),
      started: timestamp.optional(),
      finished: timestamp.optional(),
      worker: z.string().optional(),
      log: z.string().max(16384).optional(),
      error: z.string().optional(),
      events: z
        .array(z.object({ stage: z.enum(stages), at: timestamp }))
        .optional(),
    }),
  ),
});
export const fleetRpcContract = defineRpcContract({
  fleetLedger: { input: z.null(), output: ledgerSchema },
  fleetAction: { input: actionSchema, output: ledgerSchema },
  fleetImportLedgers: { input: importLedgersSchema, output: ledgerSchema },
});
