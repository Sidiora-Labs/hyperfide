import {
  experimental_PluginRpcRefusal,
  type ExperimentalPluginRpcHandlerContext,
  type HyperfidePluginApi,
} from "@hyperfide/plugin-sdk";
import {
  actionSchema,
  fleetRpcContract,
  ledgerSchema,
  importLedgersSchema,
  type FleetAction,
  type FleetLedger,
} from "./contract.js";
import type { z } from "zod";

// The dispatcher owns persistence and execution; this adapter only reads and commands it.
export interface FleetBackend {
  readLedger(): Promise<FleetLedger>;
  cancelJob(id: string): Promise<void>;
  destroyMachine(id: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setCap(cap: number): Promise<void>;
  importLedgers?(input: z.infer<typeof importLedgersSchema>): Promise<void>;
}

export function createFleetHandlers(backend: FleetBackend) {
  const fleetLedger = async () => {
    const ledger = ledgerSchema.parse(await backend.readLedger());
    return {
      ...ledger,
      jobs: ledger.jobs.map((job) => ({ ...job, log: job.log.slice(-16384) })),
    };
  };
  // Serialize mutations so two cap changes cannot apply out of order.
  let queue = Promise.resolve();
  const fleetAction = (input: FleetAction): Promise<FleetLedger> => {
    const operation = queue.then(async () => {
      const action = actionSchema.parse(input);
      const ledger = await fleetLedger();
      if (!ledger.authority.capabilities.includes("legacy-mutate")) {
        throw new Error(
          "MANAGER_DECISION_REQUIRED: use the authenticated managerDecision tool",
        );
      }
      switch (action.kind) {
        case "cancel":
          if (!ledger.jobs.some((job) => job.id === action.id))
            throw new Error("Unknown job");
          await backend.cancelJob(action.id);
          break;
        case "destroy":
          if (!ledger.machines.some((machine) => machine.id === action.id))
            throw new Error("Unknown machine");
          await backend.destroyMachine(action.id);
          break;
        case "pause":
          await backend.setPaused(true);
          break;
        case "resume":
          await backend.setPaused(false);
          break;
        case "raiseCap":
          await backend.setCap(
            Math.min(
              ledger.budget.maximum,
              Math.max(ledger.budget.cap, action.cap),
            ),
          );
          break;
      }
      return fleetLedger();
    });
    queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
  const fleetImportLedgers = async (
    input: z.infer<typeof importLedgersSchema>,
  ) => {
    if (!backend.importLedgers)
      throw new Error("Ledger imports are unavailable");
    await backend.importLedgers(importLedgersSchema.parse(input));
    return fleetLedger();
  };
  return { fleetLedger, fleetAction, fleetImportLedgers };
}

export function registerFleetRpc(
  api: Pick<HyperfidePluginApi, "rpc">,
  backend: FleetBackend,
) {
  const handlers = createFleetHandlers(backend);
  const requireClient = (context: ExperimentalPluginRpcHandlerContext) => {
    if (context.experimental_caller.kind !== "client") {
      throw new experimental_PluginRpcRefusal({
        code: "forbidden",
        message: "Fleet mutations require an authenticated client principal",
      });
    }
  };
  api.rpc.register(fleetRpcContract, {
    fleetLedger: handlers.fleetLedger,
    fleetAction: (input, context) => {
      requireClient(context);
      return handlers.fleetAction(input);
    },
    fleetImportLedgers: (input, context) => {
      requireClient(context);
      return handlers.fleetImportLedgers(input);
    },
  }, {
    experimental_discoverable: true,
    experimental_description: "Read and control the dispatch fleet",
  });
}
