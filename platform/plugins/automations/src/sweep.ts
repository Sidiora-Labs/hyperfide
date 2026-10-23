import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  listDueAutomations,
  parseAutomationExecution,
  parseAutomationTrigger,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import {
  errorMessage,
  executeAgentRun,
  executeScriptRun,
  type AgentRunApi,
  type ScriptRunApi,
} from "./run.js";
import {
  createScriptWorkingDirectoryResolver,
  type ScriptWorkingDirectoryResolver,
} from "./working-directory.js";

const DUE_AUTOMATION_BATCH_SIZE = 100;
export const SWEEP_INTERVAL_MS = 10_000;

const hostListSchema = z.array(
  z.object({ status: z.enum(["connected", "disconnected"]) }).passthrough(),
);
type SweepApi = AgentRunApi &
  ScriptRunApi & {
    sdk: { hosts: { list(): Promise<unknown> } };
  };

function buildScheduleFailureHandler(
  db: Db,
  args: {
    run: AutomationRunRow;
  },
): (error: unknown) => void {
  return (error) => {
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: errorMessage(error),
      now: Date.now(),
    });
  };
}

async function processDueAutomation(
  hyperfide: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    automation: AutomationRow;
    now: number;
    agentHostsAvailable: boolean;
    serverUrl: string;
    resolveWorkingDirectory: ScriptWorkingDirectoryResolver;
  },
): Promise<void> {
  if (args.automation.nextRunAt === null) return;
  const expectedNextRunAt = args.automation.nextRunAt;
  let newNextRunAt: number | null;
  let execution;
  try {
    const trigger = parseAutomationTrigger(args.automation.triggerConfig);
    execution = parseAutomationExecution(args.automation.execution);
    newNextRunAt =
      trigger.triggerType === "once"
        ? null
        : computeNextScheduledTime({
            cron: trigger.cron,
            now: args.now,
            timezone: trigger.timezone,
          });
  } catch (error) {
    hyperfide.log.error(
      `Skipping due automation ${args.automation.id} with invalid stored configuration: ${errorMessage(error)}`,
    );
    return;
  }

  if (execution.mode === "agent" && !args.agentHostsAvailable) {
    return;
  }

  const claim = claimAutomationScheduledRun(db, {
    automationId: args.automation.id,
    expectedNextRunAt,
    newNextRunAt,
    now: args.now,
  });
  if (!claim.advanced) return;
  publishAutomationChange(hyperfide, args.automation.projectId, [
    "automations-changed",
    "automation-runs-changed",
  ]);
  const onFailure = buildScheduleFailureHandler(db, {
    run: claim.run,
  });
  if (execution.mode === "agent") {
    await executeAgentRun(hyperfide, db, {
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
    });
  } else {
    void executeScriptRun(hyperfide, db, {
      pluginDataDir: args.pluginDataDir,
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
      serverUrl: args.serverUrl,
      resolveWorkingDirectory: args.resolveWorkingDirectory,
    }).catch((error: unknown) => {
      hyperfide.log.error(
        `Detached script automation ${args.automation.id} failed unexpectedly: ${errorMessage(error)}`,
      );
    });
  }
}

async function hasConnectedHost(
  hyperfide: Pick<HyperfidePluginApi, "log"> & {
    sdk: { hosts: { list(): Promise<unknown> } };
  },
): Promise<boolean> {
  try {
    return hostListSchema
      .parse(await hyperfide.sdk.hosts.list())
      .some((host) => host.status === "connected");
  } catch (error) {
    hyperfide.log.warn(
      `Failed to list hosts for automation sweep: ${errorMessage(error)}`,
    );
    return false;
  }
}

export async function sweepDueAutomations(
  hyperfide: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    serverUrl: string;
    serverHostId: string | null;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const due = listDueAutomations(db, { now, limit: DUE_AUTOMATION_BATCH_SIZE });
  if (due.length === 0) return;
  const agentHostsAvailable = await hasConnectedHost(hyperfide);
  const resolveWorkingDirectory = createScriptWorkingDirectoryResolver({
    sdk: hyperfide.sdk,
    pluginDataDir: args.pluginDataDir,
    serverHostId: args.serverHostId,
  });
  for (const automation of due) {
    try {
      await processDueAutomation(hyperfide, db, {
        pluginDataDir: args.pluginDataDir,
        automation,
        now,
        agentHostsAvailable,
        serverUrl: args.serverUrl,
        resolveWorkingDirectory,
      });
    } catch (error) {
      hyperfide.log.error(
        `Failed to process due automation ${automation.id}: ${errorMessage(error)}`,
      );
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}
