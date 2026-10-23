import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { migrations } from "./data.js";
import { ingestLegacyImport } from "./legacy-import.js";
import { pluginDataDirFromDb } from "./path.js";
import { automationRpcContract, createRpcHandlers } from "./rpc.js";
import {
  closeAutomationRunForSettledThread,
  disableAutomationsForDeletedThreadEvent,
  errorMessage,
  reconcileRunningAutomationRuns,
} from "./run.js";
import { registerAutomationCli } from "./cli.js";
import { createAutomationService } from "./service.js";
import { sleep, sweepDueAutomations, SWEEP_INTERVAL_MS } from "./sweep.js";

function resolveServerUrl(): string {
  return process.env.HYPERFIDE_SERVER_URL?.trim() || "http://127.0.0.1:38886";
}

export default async function plugin(hyperfide: HyperfidePluginApi) {
  const db = hyperfide.storage.database();
  hyperfide.storage.migrate(db, migrations);
  const pluginDataDir = pluginDataDirFromDb(db);
  await ingestLegacyImport({ hyperfide, db, pluginDataDir });

  const service = createAutomationService({
    hyperfide,
    db,
    pluginDataDir,
    serverUrl: resolveServerUrl(),
  });

  hyperfide.rpc.register(automationRpcContract, createRpcHandlers(service));
  registerAutomationCli({ hyperfide, service });

  hyperfide.events.on("thread.idle", ({ thread }) => {
    closeAutomationRunForSettledThread(hyperfide, db, {
      threadId: thread.id,
      status: "idle",
    });
  });
  hyperfide.events.on("thread.failed", ({ thread, error }) => {
    closeAutomationRunForSettledThread(hyperfide, db, {
      threadId: thread.id,
      status: "failed",
      error,
    });
  });

  hyperfide.events.on("thread.deleted", ({ thread }) => {
    disableAutomationsForDeletedThreadEvent(hyperfide, db, thread.id);
  });

  hyperfide.background.service("automation-sweep", {
    async start(signal) {
      try {
        await reconcileRunningAutomationRuns(hyperfide, db);
      } catch (error) {
        hyperfide.log.error(
          `Automation startup reconciliation failed: ${errorMessage(error)}`,
        );
      }
      let serverHostId: string | null = null;
      while (!signal.aborted) {
        try {
          serverHostId ??= (await hyperfide.sdk.system.config()).primaryHostId;
          await sweepDueAutomations(hyperfide, db, {
            pluginDataDir,
            serverUrl: resolveServerUrl(),
            serverHostId,
          });
        } catch (error) {
          hyperfide.log.error(`Automation sweep failed: ${errorMessage(error)}`);
        }
        await sleep(SWEEP_INTERVAL_MS, signal);
      }
    },
  });
}
