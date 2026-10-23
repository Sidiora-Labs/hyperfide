import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";

export const stages = [
  "created",
  "prepared",
  "running",
  "packed",
  "collected",
  "merged",
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
    }),
  ),
  budget: z.object({
    cap: z.number().int().nonnegative(),
    maximum: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    keys: z.number().int().nonnegative(),
    backoffUntil: timestamp.nullable(),
    paused: z.boolean(),
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
export const fleetRpcContract = defineRpcContract({
  fleetLedger: { input: z.null(), output: ledgerSchema },
  fleetAction: { input: actionSchema, output: ledgerSchema },
});
