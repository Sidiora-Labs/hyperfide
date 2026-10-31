import { getEnvironment, getHost, type DbQueryConnection } from "@hyperfide/db";
import type { Thread } from "@hyperfide/domain";
import { ApiError } from "../../errors.js";

export async function assertThreadHostAcceptsWork(
  db: DbQueryConnection,
  thread: Pick<Thread, "environmentId">,
): Promise<void> {
  if (thread.environmentId === null) return;
  const environment = await getEnvironment(db, thread.environmentId);
  if (environment === null) return;
  const host = await getHost(db, environment.hostId);
  if (host?.phase === "removing") {
    throw new ApiError(
      409,
      "machine_removing",
      "Machine removal has begun; this thread is read-only",
    );
  }
  if (
    host !== null &&
    (host.destroyedAt !== null || host.phase === "destroyed")
  ) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
}
