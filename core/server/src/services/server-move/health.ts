import type { ServerMoveHealth } from "@hyperfide/host-daemon-contract";
import { readLastServerMoveFile } from "@hyperfide/server-archive";
import type { PendingServerMove } from "./pending-boot.js";

export interface ReadServerMoveHealthArgs {
  dataDir: string;
  pending: PendingServerMove | null;
}

export async function readServerMoveHealth(
  args: ReadServerMoveHealthArgs,
): Promise<ServerMoveHealth | null> {
  const lastMoveId = await readLastServerMoveFile(args.dataDir).then(
    (file) => file?.moveId ?? null,
    () => null,
  );
  if (args.pending !== null) {
    return {
      moveId: args.pending.moveId,
      state: lastMoveId === args.pending.moveId ? "activating" : "pending",
    };
  }
  return lastMoveId === null ? null : { moveId: lastMoveId, state: "ready" };
}
