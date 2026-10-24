import { getExperiments, type DbConnection } from "@hyperfide/db";
import { startPerformanceDiagnostics } from "@hyperfide/process-utils";
import type { ServerLogger } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";

export async function startGatedPerformanceDiagnostics(options: {
  allowed: boolean;
  dataDir: string;
  db: DbConnection;
  hub: NotificationHub;
  logger: Pick<ServerLogger, "info" | "warn">;
}): Promise<{ isEnabled: () => boolean; stop: () => Promise<void> }> {
  let enabled = false;
  let stopped = false;
  let recorder: Awaited<ReturnType<typeof startPerformanceDiagnostics>> | null =
    null;
  let pending = Promise.resolve();
  const refresh = async (): Promise<void> => {
    enabled =
      !stopped &&
      options.allowed &&
      (await getExperiments(options.db)).performanceDiagnostics;
    pending = pending
      .then(async () => {
        if (enabled && recorder === null) {
          recorder = await startPerformanceDiagnostics({
            dataDir: options.dataDir,
            logger: options.logger,
          });
        }
        if (!enabled && recorder !== null) {
          await recorder.stop();
          recorder = null;
          options.logger.info({}, "Server performance diagnostics stopped");
        }
      })
      .catch((error: unknown) => {
        options.logger.warn(
          { err: error },
          "Could not update server performance diagnostics",
        );
      });
    return pending;
  };
  const unsubscribe = options.allowed
    ? options.hub.onChangedMessage(async (message) => {
        if (
          message.entity === "system" &&
          message.changes.includes("config-changed")
        )
          await refresh();
      })
    : () => {};
  await refresh();
  return {
    isEnabled: () => enabled,
    stop: async () => {
      stopped = true;
      unsubscribe();
      return await refresh();
    },
  };
}
