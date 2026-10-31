import {
  getLatestThreadSequence,
  getNonDestroyedHostByLaunchKey,
} from "@hyperfide/db";
import { sweepProviderMachine } from "../machines/provider-orchestration.js";
import { cancelProviderEnvironmentCreation } from "../environments/environment-engine.js";
import { getPreparingEnvironment } from "@hyperfide/db";
import {
  getThread,
  type DbTransaction,
  type EnvironmentRow,
} from "@hyperfide/db";
import {
  type EnvironmentProviderSelection,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type SystemMessageKind,
  type SystemMessageSubject,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@hyperfide/domain";
import type { StartedOnBehalfOf } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendClientTurnEvent,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
  createClientTurnRequestId,
} from "./thread-events.js";
import {
  hasLiveThreadStartInFlight,
  requestThreadStart,
} from "./thread-lifecycle.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  createThreadStartup,
  type ThreadForkDescriptor,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionContext,
} from "./thread-startup-store.js";
import {
  ensureThreadProvisionEnvironmentReady,
  ensureWorkspaceReadyEvent,
  failThreadProvisioning,
  type ThreadProvisioningDeps,
} from "./thread-provisioning-environment.js";
import {
  clearThreadProvisionSchedule,
  getThreadProvisionContext,
  saveThreadProvisionContext,
  readThreadProvisionContext,
} from "./thread-startup-store.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";

interface RequestThreadProvisionArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  input: PromptInput[];
  providerInput?: PromptInput[];
  startedOnBehalfOf: StartedOnBehalfOf | null;
  thread: Thread;
  titleProvided: boolean;
}

interface RequestThreadTargetReprovisionArgs {
  beforeRequestAppendInTransaction?: (args: {
    tx: DbTransaction;
  }) => void | Promise<void>;
  environment: EnvironmentRow;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  initiator: ThreadTurnInitiator;
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  provider: {
    environmentProviderId: string;
    selection: EnvironmentProviderSelection;
  };
  thread: Thread;
}

interface RequestThreadEnvironmentRestoreArgs {
  environment: EnvironmentRow;
  provider: {
    environmentProviderId: string;
    selection: EnvironmentProviderSelection;
  };
  thread: Thread;
}

interface AdvanceThreadProvisioningArgs {
  threadId: string;
}

interface CurrentProvisioningFailureThreadArgs {
  context: ThreadProvisionContext;
  threadId: string;
}

interface EnvironmentPayloadThreadArgs {
  context: ThreadProvisionContext;
  environment: EnvironmentRow;
  thread: Thread;
}

async function getCurrentProvisioningFailureThread(
  deps: Pick<AppDeps, "db">,
  args: CurrentProvisioningFailureThreadArgs,
): Promise<Thread | null> {
  const currentThread = await getThread(deps.db, args.threadId);
  if (!currentThread || currentThread.deletedAt !== null) {
    clearThreadProvisionSchedule(args.threadId);
    return null;
  }
  if (
    currentThread.status !== "starting" ||
    currentThread.archivedAt !== null
  ) {
    clearThreadProvisionSchedule(args.threadId);
    return null;
  }

  const activeContext = await getThreadProvisionContext(deps.db, args.threadId);
  if (
    activeContext === null ||
    activeContext.state.provisioningId !== args.context.state.provisioningId
  ) {
    return null;
  }

  return currentThread;
}

interface SettleSeededThreadProvisioningArgs {
  context: ThreadProvisionContext;
  environmentId: string;
  threadId: string;
}

async function settleSeededThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: SettleSeededThreadProvisioningArgs,
): Promise<void> {
  const settled = await deps.db.transaction(
    async (tx) => {
      const current = await getThreadProvisionContext(tx, args.threadId);
      const outcome = await applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { threadId: args.threadId, event: { type: "run.succeeded" } },
      );
      const completedProvisioning =
        outcome.applied &&
        current !== null &&
        current.state.provisioningId === args.context.state.provisioningId &&
        current.state.provisionEventSequence !== null;
      if (completedProvisioning) {
        await appendThreadProvisioningEventInTransaction(tx, {
          threadId: args.threadId,
          environmentId: args.environmentId,
          provisioningId: current.state.provisioningId,
          status: "completed",
          entries: [],
        });
      }
      return { completedProvisioning, outcome };
    },
    { behavior: "immediate" },
  );
  if (!settled.outcome.applied) {
    deps.logger.warn(
      { threadId: args.threadId },
      "Seed-without-run thread was no longer starting; idle settle skipped",
    );
    return;
  }
  await deps.hub.notifyThread(
    args.threadId,
    ["status-changed"],
    await buildThreadStatusChangeMetadata(deps, settled.outcome.thread),
  );
  if (settled.completedProvisioning) {
    await deps.hub.notifyThread(args.threadId, ["events-appended"], {
      timelineSequence: await getLatestThreadSequence(deps.db, {
        threadId: args.threadId,
      }),
      eventTypes: ["system/thread-provisioning"],
    });
  }
}

async function startThreadIfEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): Promise<void> {
  if (args.environment.status === "error") {
    await failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment provisioning failed",
    });
    return;
  }
  if (args.environment.status === "provisioning") {
    return;
  }
  if (args.environment.status !== "ready") {
    await failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: `Environment is ${args.environment.status}`,
    });
    return;
  }
  if (!args.environment.path) {
    await failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is ready without a workspace path",
    });
    return;
  }

  const workspaceReady = await ensureWorkspaceReadyEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    entries: buildCwdBranchEntries({
      path: args.environment.path,
      branchName: args.environment.branchName,
      headSha: null,
    }),
  });
  if (!workspaceReady) {
    throw new Error("Thread did not reach workspace-ready provisioning state");
  }

  // The workspace exists, so anything that queued waiting for it stops
  // waiting here rather than after the dispatch below: the wait is over at
  // this line, and the `run.succeeded` branch below returns without
  // dispatching anything. A thread with nothing queued no-ops.
  await requestQueuedMessageDispatch(deps, {
    kind: "workspace-ready",
    threadId: args.thread.id,
  });

  if (
    args.context.request.seedWithoutRun &&
    args.context.request.fork === null
  ) {
    await settleSeededThreadProvisioning(deps, {
      context: args.context,
      environmentId: args.environment.id,
      threadId: args.thread.id,
    });
    return;
  }

  const execution = args.context.request.execution;
  if (execution === null) {
    throw new Error("Thread provisioning that starts a run has no execution");
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
    },
    fork: args.context.request.fork,
    input: args.context.request.input,
    ...(args.context.request.inputGroups !== undefined
      ? { inputGroups: args.context.request.inputGroups }
      : {}),
    requestId: args.context.request.clientRequestId,
    execution,
    permissionEscalation: resolvePermissionEscalation({
      initiator: "user",
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: !args.context.request.titleProvided,
  });
}

export async function requestThreadProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadProvisionArgs,
): Promise<ThreadProvisionContext> {
  return await deps.db.transaction(async () => {
    const { initiator, senderThreadId } = resolveDispatchAuthor({
      retrying: false,
      senderThreadId: null,
      startedOnBehalfOf: args.startedOnBehalfOf,
    });
    const target: TurnRequestTarget = { kind: "thread-start" };
    const request = await appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/turn/requested",
      input: args.input,
      execution: args.execution,
      initiator,
      senderThreadId,
      requestMethod: "thread/start",
      source: "spawn",
      target,
    });
    await recordAcceptedPromptHistoryEntry(deps, {
      thread: args.thread,
      input: args.input,
      initiator,
      target,
      requestSequence: request.sequence,
    });
    await appendClientTurnEvent(deps, {
      threadId: args.thread.id,
      environmentId: args.thread.environmentId,
      type: "client/thread/start",
      initiator,
      requestMethod: "thread/start",
      source: "spawn",
    });

    const context = createThreadStartup({
      ...args,
      clientRequestId: request.requestId,
      input: args.providerInput ?? args.input,
      seedWithoutRun: args.startedOnBehalfOf !== null,
    });
    await saveThreadProvisionContext({
      replace: true,
      db: deps.db,
      threadId: args.thread.id,
      context,
    });
    return context;
  });
}

export async function requestThreadEnvironmentRestore(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
  args: RequestThreadEnvironmentRestoreArgs,
): Promise<ThreadProvisionContext | null> {
  return await deps.db.transaction(
    async (tx) => {
      const prepared = await applyLoggedThreadLifecycleEventInTransaction(
        { db: tx, logger: deps.logger },
        { event: { type: "run.preparing" }, threadId: args.thread.id },
      );
      if (!prepared.applied) {
        return null;
      }
      const context = createThreadStartup({
        clientRequestId: createClientTurnRequestId(),
        environmentIntent: {
          type: "provider",
          environmentProviderId: args.provider.environmentProviderId,
          machine: { type: "existing", hostId: args.environment.hostId },
          inputs: args.provider.selection.inputs,
          selectionResolved: true,
        },
        execution: null,
        fork: null,
        input: [],
        seedWithoutRun: true,
        titleProvided: true,
      });
      await saveThreadProvisionContext({
        replace: true,
        db: tx,
        threadId: args.thread.id,
        context,
      });
      return context;
    },
    { behavior: "immediate" },
  );
}

export async function requestThreadTargetReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadTargetReprovisionArgs,
): Promise<ThreadProvisionContext> {
  return await deps.db.transaction(async () => {
    const request = await appendReprovisionTurnRequest(deps, args);
    const context = createThreadStartup({
      clientRequestId: request.requestId,
      environmentIntent:
        args.environment.status === "error" &&
        args.environment.path !== null &&
        args.environment.teardownStatus === null
          ? { type: "reuse", environmentId: args.environment.id }
          : {
              type: "provider",
              environmentProviderId: args.provider.environmentProviderId,
              machine: {
                type: "existing",
                hostId: args.environment.hostId,
              },
              inputs: args.provider.selection.inputs,
              selectionResolved: true,
            },
      execution: args.execution,
      fork: null,
      input: args.input,
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      seedWithoutRun: false,
      titleProvided: true,
    });
    await saveThreadProvisionContext({
      replace: true,
      db: deps.db,
      threadId: args.thread.id,
      context,
    });
    return context;
  });
}

async function appendReprovisionTurnRequest(
  deps: Pick<AppDeps, "db" | "hub">,
  args: Omit<RequestThreadTargetReprovisionArgs, "provider">,
) {
  const requestId = createClientTurnRequestId();
  const request = await deps.db.transaction(
    async (tx) => {
      await args.beforeRequestAppendInTransaction?.({ tx });
      const request =
        await appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
          tx,
          {
            threadId: args.thread.id,
            environmentId: args.environment.id,
            type: "client/turn/requested",
            input: args.input,
            ...(args.inputGroups !== undefined
              ? { inputGroups: args.inputGroups }
              : {}),
            execution: args.execution,
            initiator: args.initiator,
            senderThreadId: args.senderThreadId,
            systemMessageKind: args.systemMessageKind,
            systemMessageSubject: args.systemMessageSubject,
            requestMethod: "turn/start",
            source: "tell",
            target: { kind: "new-turn" },
            requestId,
          },
        );
      await recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread: args.thread,
          input: args.input,
          initiator: args.initiator,
          target: { kind: "new-turn" },
          requestSequence: request.sequence,
        },
      );
      return request;
    },
    { behavior: "immediate" },
  );
  await deps.hub.notifyThread(
    args.thread.id,
    request.notificationChanges,
    request.notificationMetadata,
  );
  return request;
}

async function advanceThreadProvisioningOnce(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  const thread = await getThread(deps.db, args.threadId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    hasLiveThreadStartInFlight(thread.id)
  ) {
    return;
  }
  if (thread.status !== "starting") {
    clearThreadProvisionSchedule(thread.id);
    return;
  }
  let context = await getThreadProvisionContext(deps.db, thread.id);
  if (!context) {
    await failThreadProvisioning(deps, {
      thread,
      environmentId: thread.environmentId,
      detail: "Thread setup did not finish. Retry the thread to continue.",
    });
    return;
  }
  if (thread.archivedAt !== null) {
    return;
  }

  try {
    const ready = await ensureThreadProvisionEnvironmentReady(deps, {
      context,
      thread,
    });
    if (ready === null) {
      return;
    }
    context = ready.context;
    await startThreadIfEnvironmentReady(deps, {
      context: ready.context,
      environment: ready.environment,
      thread: ready.thread,
    });
  } catch (error) {
    const failureThread = await getCurrentProvisioningFailureThread(deps, {
      context,
      threadId: thread.id,
    });
    if (!failureThread) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await failThreadProvisioning(deps, {
      thread: failureThread,
      environmentId: context.state.environmentId ?? failureThread.environmentId,
      detail,
    });
  }
}

export async function advanceThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  await deps.lifecycleDedupers.threadProvisionAdvance.run(
    args.threadId,
    async () => await advanceThreadProvisioningOnce(deps, args),
  );
}

/**
 * Drives provisioning off the caller's stack. Creation returns the thread row
 * before the workspace exists, and a cold-start row whose wait cleared returns
 * to its sweep or route the same way, so neither waits on the daemon.
 */
export function scheduleThreadProvisioningAdvance(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  threadId: string,
): void {
  void advanceThreadProvisioning(deps, {
    threadId,
  }).catch((error) => {
    deps.logger.warn(
      {
        threadId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Failed to advance thread provisioning",
    );
  });
}

export async function restoreInterruptedThreadStartupRequest(
  deps: ThreadProvisioningDeps,
  threadId: string,
): Promise<ThreadProvisionContext["request"] | null> {
  const context = await readThreadProvisionContext(deps.db, threadId);
  if (context === null) return null;
  const provisioning = await getPreparingEnvironment(deps.db, threadId);
  if (provisioning !== null) {
    await cancelProviderEnvironmentCreation(deps, threadId);
  }
  const machine = await getNonDestroyedHostByLaunchKey(deps.db, threadId);
  if (machine?.phase === "removing") {
    await sweepProviderMachine(deps, machine.id);
  }
  return context.request;
}
