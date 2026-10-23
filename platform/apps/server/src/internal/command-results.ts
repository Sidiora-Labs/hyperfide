import type {
  HostDaemonCommand,
  HostDaemonSettledCommandType,
} from "@hyperfide/host-daemon-contract";
import {
  emptyCommandResultSideEffects,
  type CommandResultReportForType,
  type CommandResultSettlementDeps,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
} from "./command-result-side-effects.js";
import {
  settleEnvironmentProvisionCancelCommandResult,
  settleEnvironmentProvisionCommandResult,
} from "../services/environments/environment-engine.js";
import {
  settleThreadPlanCancelCommandResult,
  settleThreadStartCommandResult,
  settleThreadStorageDeleteCommandResult,
  settleThreadStopCommandResult,
  settleTurnSubmitCommandResult,
} from "../services/threads/thread-lifecycle.js";
import { notifyWorkspaceMutationResult } from "./environment-changes.js";

type ParsedCommandType = HostDaemonSettledCommandType;
type ParsedCommandForType<TType extends ParsedCommandType> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

interface ApplyCommandResultSideEffectsArgs<TType extends ParsedCommandType> {
  command: ParsedCommandForType<TType>;
  deps: CommandResultSettlementDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: CommandResultReportForType<TType>;
}

type CommandResultSideEffectHandlers = {
  [TType in ParsedCommandType]?: (
    args: ApplyCommandResultSideEffectsArgs<TType>,
  ) =>
    | CommandResultSideEffectsResult
    | void
    | Promise<CommandResultSideEffectsResult | void>;
};

const commandResultSideEffectHandlers: CommandResultSideEffectHandlers = {
  "environment.attach": settleEnvironmentProvisionCommandResult,
  "environment.attach.cancel": settleEnvironmentProvisionCancelCommandResult,
  "interactive.resolve": async ({ deps, command, report }) => {
    await deps.pendingInteractions.settleInteractiveResolveCommandResultInTransaction(
      {
        command,
        deps,
        report,
      },
    );
  },
  "thread.start": settleThreadStartCommandResult,
  "thread.stop": settleThreadStopCommandResult,
  "thread.storage.delete": settleThreadStorageDeleteCommandResult,
  "thread.plan.cancel": settleThreadPlanCancelCommandResult,
  "turn.submit": settleTurnSubmitCommandResult,
  "workspace.commit": ({ deps, command, report }) => {
    notifyWorkspaceMutationResult(deps, {
      environmentId: command.environmentId,
      ok: report.ok,
    });
  },
} satisfies CommandResultSideEffectHandlers;

export async function handleLiveCommandResultSideEffects<
  TType extends ParsedCommandType,
>(
  deps: CommandResultSettlementDeps,
  args: {
    command: ParsedCommandForType<TType>;
    execution: HostDaemonCommandExecutionRecord;
    report: CommandResultReportForType<TType>;
  },
): Promise<CommandResultSideEffectsResult> {
  const handler = commandResultSideEffectHandlers[args.command.type];
  if (!handler) {
    return emptyCommandResultSideEffects();
  }

  return (
    (await handler({
      deps,
      report: args.report,
      command: args.command,
      execution: args.execution,
    })) ?? emptyCommandResultSideEffects()
  );
}
