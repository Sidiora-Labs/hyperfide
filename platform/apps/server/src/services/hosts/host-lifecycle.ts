import { assertMachineLifecycleAdmission } from "../machines/lifecycle.js";
import { getHost } from "@hyperfide/db";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireConnectedHostSession } from "../lib/entity-lookup.js";
import {
  resumeMachine,
  waitForMachineMaintenance,
} from "../machines/provider-orchestration.js";

export async function ensureHostSessionReadyForWork(
  deps: WorkSessionDeps,
  args: { hostId: string },
) {
  const host = await getHost(deps.db, args.hostId);
  if (!host || host.destroyedAt !== null) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  if (host.phase === "removing") {
    throw new ApiError(
      409,
      "machine_removing",
      "Machine removal has begun; wait for a replacement machine",
    );
  }

  await waitForMachineMaintenance(deps, host.id);
  await resumeMachine(deps, host.id);
  await assertMachineLifecycleAdmission(deps, host.id);
  const current = await getHost(deps.db, host.id);
  if (current?.phase === "removing") {
    throw new ApiError(
      409,
      "machine_removing",
      "Machine removal has begun; wait for a replacement machine",
    );
  }

  return await requireConnectedHostSession(deps, host.id);
}
