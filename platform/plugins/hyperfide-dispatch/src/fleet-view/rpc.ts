import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import {
  actionSchema,
  fleetRpcContract,
  ledgerSchema,
  type FleetAction,
  type FleetLedger,
} from "./contract.js";

// The dispatcher owns persistence and execution; this adapter only reads and commands it.
export interface FleetBackend {
  readLedger(): Promise<FleetLedger>;
  cancelJob(id: string): Promise<void>;
  destroyMachine(id: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setCap(cap: number): Promise<void>;
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
  return { fleetLedger, fleetAction };
}

export function registerFleetRpc(
  api: Pick<HyperfidePluginApi, "rpc">,
  backend: FleetBackend,
) {
  api.rpc.register(fleetRpcContract, createFleetHandlers(backend));
}
