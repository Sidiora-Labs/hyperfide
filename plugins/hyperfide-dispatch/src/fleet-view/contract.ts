import { defineRpcContract } from "@hyperfide/plugin-sdk";
import { z } from "zod";

/** Realtime channel emitted after a fleet projection mutation or reconciliation. */
export const FLEET_CHANGED_CHANNEL = "fleet:changed";

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
const authorityRole = z.enum(["PRIMARY", "FEATURE_MANAGER", "OPERATOR", "UNKNOWN"]);
const authorityMode = z.enum(["manager", "legacy-nonadaptive"]);
const authorityCapability = z.enum(["read", "legacy-mutate", "manager-decision"]);
export const fleetAuthoritySchema = z.object({
  /** Which planner owns mutations for this ledger. */
  mode: authorityMode,
  state: z.string().min(1),
  actorRole: authorityRole.nullable(),
  capabilities: z.array(authorityCapability),
  authorityEpoch: z.string().nullable(),
  leaderGeneration: z.string().nullable(),
  delegationId: z.string().nullable(),
  managerGeneration: z.string().nullable(),
  asOf: timestamp,
});
export const ledgerSchema = z.object({
  authority: fleetAuthoritySchema.default({
    mode: "manager",
    state: "UNKNOWN",
    actorRole: null,
    capabilities: ["read"],
    authorityEpoch: null,
    leaderGeneration: null,
    delegationId: null,
    managerGeneration: null,
    asOf: "1970-01-01T00:00:00.000Z",
  }),
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
      reconciliation: z.string().optional(),
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
      // UNKNOWN and RECONCILING are durable observations, not terminal
      // failures. They must survive imports and remain visible to operators.
      state: z.enum([
        "claimed",
        "running",
        "succeeded",
        "failed",
        "unknown",
        "reconciling",
      ]),
      attempt: z.number().int().nonnegative(),
      keyId: z.string(),
      commits: z.array(z.string()),
      machine: z.string().optional(),
      started: timestamp.optional(),
      finished: timestamp.optional(),
      worker: z.string().optional(),
      log: z.string().max(16384).optional(),
      error: z.string().optional(),
      reconciliation: z.string().optional(),
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
