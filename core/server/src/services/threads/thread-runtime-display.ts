import {
  getEnvironment,
  getSessionById,
  listActiveBackgroundTaskCountsByThreadIds,
  listLatestClosedSessionsForHosts,
  listLatestThreadStateEventRowsByThreadIds,
  listOpenTurnInputAcceptedRowsByThreadIds,
  listStoredClientTurnRequestRowsByKeys,
  type DbConnection,
  type HostDaemonSessionRow,
  type StoredEventRow,
  type ThreadClientTurnRequestKey,
  type ThreadWithPendingInteractionState,
} from "@hyperfide/db";
import { LEGACY_CODEX_GOAL_EXTENSION_KIND } from "@hyperfide/domain";
import type {
  Thread,
  ThreadActivityState,
  ThreadChangeMetadata,
  ThreadListEntry,
  ThreadQueuedWork,
  ThreadRuntimeState,
  ThreadStatus,
  ThreadWithRuntime,
} from "@hyperfide/domain";
import {
  extractThreadTimelineActivePlanTurn,
  extractThreadTimelineGoal,
  type ThreadEventWithMeta,
} from "@hyperfide/thread-view";
import type { ThreadResponse } from "@hyperfide/server-contract";
import type { NotificationHub } from "../../ws/hub.js";
import { isHostDisconnectHidden } from "../hosts/host-disconnect-display.js";
import { resolveProviderPlanCommand } from "../providers/provider-plan-command.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { listQueuedThreadMessageCountsByThreadIds } from "@hyperfide/db";
import { resolveEnvironmentWorkspaceDisplayKind } from "../environments/environment-response.js";
import { canThreadSpawnChild } from "./thread-parent.js";
import { canRestoreThreadEnvironment } from "./thread-environment-restore.js";
import {
  canThreadEditMessages,
  type ThreadMessageEditPolicyDeps,
} from "./thread-message-edit-policy.js";
import { toThreadEventWithMeta } from "./timeline.js";
import { intendedThreadHostId } from "./dispatch-attempt.js";

type ThreadRuntimeDisplayHub = Pick<
  NotificationHub,
  "getDaemonSessionIdForHost"
>;

interface ThreadRuntimeDisplayDeps {
  db: DbConnection;
  hub: ThreadRuntimeDisplayHub;
}

interface ThreadPromptBannerDeps extends ThreadRuntimeDisplayDeps {
  providerRegistry: ProviderRegistryService;
}

interface ResolveThreadRuntimeStateArgs {
  environmentHostId: string | null;
  now?: number;
  status: ThreadStatus;
}

interface ResolveThreadRuntimeStateFromLatestSessionArgs {
  environmentHostId: string | null;
  hostConnected: boolean;
  latestClosedSession: HostDaemonSessionRow | null;
  now?: number;
  status: ThreadStatus;
}

interface ToThreadResponseFromThreadArgs {
  now?: number;
  thread: Thread;
}

interface ToThreadResponseWithHostArgs extends ToThreadResponseFromThreadArgs {
  environmentHostId: string | null;
}

interface ToThreadListEntryResponsesArgs {
  now?: number;
  threads: readonly ThreadWithPendingInteractionState[];
}

interface ToThreadListEntryResponseFromLatestSessionArgs {
  activity: ThreadActivityState;
  hostConnected: boolean;
  latestClosedSession: HostDaemonSessionRow | null;
  now?: number;
  queuedWork: ThreadQueuedWork;
  thread: ThreadWithPendingInteractionState;
}

interface BuildThreadStatusChangeMetadataByThreadIdArgs {
  environmentHostId: string;
  threads: readonly Thread[];
}

interface ToThreadStatusChangeMetadataArgs {
  activity: ThreadActivityState;
  runtime: ThreadRuntimeState;
  thread: Thread;
}

interface PromptBannerActivityState extends Pick<
  ThreadActivityState,
  "activeGoalCount" | "activePlanModeCount"
> {
  activePlanTurnId: string | null;
}

const EMPTY_THREAD_ACTIVITY: ThreadActivityState = {
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activeGoalCount: 0,
  activePlanModeCount: 0,
  activeWorkflowCount: 0,
};

function threadStatusRuntimeState(status: ThreadStatus): ThreadRuntimeState {
  switch (status) {
    case "pending":
    case "starting":
    case "idle":
    case "active":
    case "stopping":
    case "error":
      return { displayStatus: status };
  }
}

async function hasOpenDaemonSessionForHost(
  deps: ThreadRuntimeDisplayDeps,
  hostId: string,
): Promise<boolean> {
  const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
  if (!sessionId) {
    return false;
  }
  const session = await getSessionById(deps.db, { sessionId });
  return session?.hostId === hostId && session.status === "active";
}

function toPublicThread(thread: Thread): Thread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    providerId: thread.providerId,
    title: thread.title,
    titleFallback: thread.titleFallback,
    sectionId: thread.sectionId,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    sourceThreadId: thread.sourceThreadId,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId,
    originKind: thread.originKind,
    originPluginId: thread.originPluginId,
    visibility: thread.visibility,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    deletedAt: thread.deletedAt,
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export async function resolveThreadRuntimeState(
  deps: ThreadRuntimeDisplayDeps,
  args: ResolveThreadRuntimeStateArgs,
): Promise<ThreadRuntimeState> {
  if (args.status !== "active" || args.environmentHostId === null) {
    return resolveThreadRuntimeStateFromLatestSession({
      environmentHostId: args.environmentHostId,
      hostConnected: false,
      latestClosedSession: null,
      now: args.now,
      status: args.status,
    });
  }

  const hostConnected = await hasOpenDaemonSessionForHost(
    deps,
    args.environmentHostId,
  );
  return resolveThreadRuntimeStateFromLatestSession({
    environmentHostId: args.environmentHostId,
    hostConnected,
    latestClosedSession: await getLatestClosedSessionForHost(deps, {
      hostConnected,
      hostId: args.environmentHostId,
    }),
    now: args.now,
    status: args.status,
  });
}

function resolveThreadRuntimeStateFromLatestSession(
  args: ResolveThreadRuntimeStateFromLatestSessionArgs,
): ThreadRuntimeState {
  // A `pending` thread needs no special case: it is never `active`, so it
  // falls straight through to `threadStatusRuntimeState`, which reports it as
  // itself. This used to short-circuit to a separate `held` display status
  // derived from live dispatch holds — the holds are gone and `pending` is the
  // status, so the derivation and its second vocabulary went with them.
  if (args.status !== "active" || args.environmentHostId === null) {
    return threadStatusRuntimeState(args.status);
  }

  if (
    args.hostConnected ||
    isHostDisconnectHidden(args.latestClosedSession, args.now ?? Date.now())
  ) {
    return threadStatusRuntimeState("active");
  }
  return { displayStatus: "waiting-for-host" };
}

async function getLatestClosedSessionForHost(
  deps: ThreadRuntimeDisplayDeps,
  args: { hostConnected: boolean; hostId: string },
): Promise<HostDaemonSessionRow | null> {
  if (args.hostConnected) {
    return null;
  }
  return (
    (
      await listLatestClosedSessionsForHosts(deps.db, {
        hostIds: [args.hostId],
      })
    )[0] ?? null
  );
}

async function resolveThreadEnvironmentHostId(
  deps: ThreadRuntimeDisplayDeps,
  thread: Thread,
): Promise<string | null> {
  if (thread.environmentId === null) {
    return null;
  }
  return (await getEnvironment(deps.db, thread.environmentId))?.hostId ?? null;
}

export async function buildThreadStatusChangeMetadata(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): Promise<ThreadChangeMetadata> {
  return toThreadStatusChangeMetadata({
    activity:
      (await buildThreadActivityStateByThreadId(deps, [thread])).get(
        thread.id,
      ) ?? EMPTY_THREAD_ACTIVITY,
    runtime: await resolveThreadRuntimeState(deps, {
      environmentHostId: await resolveThreadEnvironmentHostId(deps, thread),
      status: thread.status,
    }),
    thread,
  });
}

export async function buildThreadStatusChangeMetadataByThreadId(
  deps: ThreadPromptBannerDeps,
  args: BuildThreadStatusChangeMetadataByThreadIdArgs,
): Promise<Map<string, ThreadChangeMetadata>> {
  if (args.threads.length === 0) {
    return new Map();
  }
  const activityByThreadId = await buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );
  const hostConnected = await hasOpenDaemonSessionForHost(
    deps,
    args.environmentHostId,
  );
  const latestClosedSession = await getLatestClosedSessionForHost(deps, {
    hostConnected,
    hostId: args.environmentHostId,
  });
  return new Map(
    args.threads.map((thread) => [
      thread.id,
      toThreadStatusChangeMetadata({
        activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
        runtime: resolveThreadRuntimeStateFromLatestSession({
          environmentHostId: args.environmentHostId,
          hostConnected,
          latestClosedSession,
          status: thread.status,
        }),
        thread,
      }),
    ]),
  );
}

function toThreadStatusChangeMetadata(
  args: ToThreadStatusChangeMetadataArgs,
): ThreadChangeMetadata {
  return {
    projectId: args.thread.projectId,
    statusChange: {
      status: args.thread.status,
      runtime: args.runtime,
      activity: args.activity,
      latestAttentionAt: args.thread.latestAttentionAt,
      updatedAt: args.thread.updatedAt,
    },
  };
}

async function toThreadResponseWithHost(
  deps: ThreadRuntimeDisplayDeps,
  args: ToThreadResponseWithHostArgs,
): Promise<ThreadWithRuntime> {
  const thread = toPublicThread(args.thread);
  return {
    ...thread,
    runtime: await resolveThreadRuntimeState(deps, {
      environmentHostId: args.environmentHostId,
      now: args.now,
      status: thread.status,
    }),
  };
}

export async function toThreadResponseFromThread(
  deps: ThreadRuntimeDisplayDeps & ThreadMessageEditPolicyDeps,
  args: ToThreadResponseFromThreadArgs,
): Promise<ThreadResponse> {
  const threadWithRuntime = await toThreadResponseWithHost(deps, {
    ...args,
    environmentHostId: await resolveThreadEnvironmentHostId(deps, args.thread),
  });
  return {
    ...threadWithRuntime,
    activeBackgroundAgentCount:
      (
        await listActiveBackgroundTaskCountsByThreadIds(deps.db, {
          threadIds: [args.thread.id],
        })
      )[0]?.activeBackgroundAgentCount ?? 0,
    canRestoreEnvironment: await canRestoreThreadEnvironment(deps, {
      thread: args.thread,
    }),
    canEditMessages: canThreadEditMessages(deps, args.thread),
    canSpawnChild: await canThreadSpawnChild(deps, { thread: args.thread }),
    queuedMessageCount:
      (
        await listQueuedThreadMessageCountsByThreadIds(deps.db, {
          threadIds: [args.thread.id],
        })
      )[0]?.queuedMessageCount ?? 0,
  };
}

function getThreadPromptBannerActivityState(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
  events: readonly ThreadEventWithMeta[],
): PromptBannerActivityState {
  const activePlanTurn = extractThreadTimelineActivePlanTurn({
    events,
    planCommand: resolveProviderPlanCommand(
      deps.providerRegistry,
      thread.providerId,
    ),
    providerId: thread.providerId,
    threadStatus: thread.status,
  });
  const goal = extractThreadTimelineGoal(events);

  return {
    activeGoalCount: goal?.status === "active" ? 1 : 0,
    activePlanModeCount: activePlanTurn === null ? 0 : 1,
    activePlanTurnId: activePlanTurn?.turnId ?? null,
  };
}

function canThreadShowActivePlanMode(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): boolean {
  return (
    thread.status === "active" &&
    resolveProviderPlanCommand(deps.providerRegistry, thread.providerId) !==
      null
  );
}

async function listPromptBannerActivityCandidateRows(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Promise<StoredEventRow[]> {
  const latestGoalRows = await listLatestThreadStateEventRowsByThreadIds(
    deps.db,
    {
      threadIds: threads.map((thread) => thread.id),
      kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
    },
  );
  const openAcceptedRows = await listOpenTurnInputAcceptedRowsByThreadIds(
    deps.db,
    {
      threadIds: threads
        .filter((thread) => canThreadShowActivePlanMode(deps, thread))
        .map((thread) => thread.id),
    },
  );
  const openAcceptedEvents = openAcceptedRows.map(toThreadEventWithMeta);
  const requestKeys: ThreadClientTurnRequestKey[] = openAcceptedEvents.flatMap(
    ({ event }) =>
      event.type === "turn/input/accepted"
        ? [{ requestId: event.clientRequestId, threadId: event.threadId }]
        : [],
  );
  const requestRows = await listStoredClientTurnRequestRowsByKeys(deps.db, {
    keys: requestKeys,
  });

  return [...latestGoalRows, ...openAcceptedRows, ...requestRows].sort(
    (left, right) =>
      left.threadId.localeCompare(right.threadId) ||
      left.sequence - right.sequence,
  );
}

async function buildThreadPromptBannerActivityByThreadId(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Promise<Map<string, PromptBannerActivityState>> {
  const rows = await listPromptBannerActivityCandidateRows(deps, threads);
  const eventsByThreadId = new Map<string, ThreadEventWithMeta[]>();
  for (const row of rows) {
    const threadEvents = eventsByThreadId.get(row.threadId);
    const event = toThreadEventWithMeta(row);
    if (threadEvents) {
      threadEvents.push(event);
    } else {
      eventsByThreadId.set(row.threadId, [event]);
    }
  }

  const result = new Map<string, PromptBannerActivityState>();
  for (const thread of threads) {
    const activity = getThreadPromptBannerActivityState(
      deps,
      thread,
      eventsByThreadId.get(thread.id) ?? [],
    );
    if (activity.activeGoalCount > 0 || activity.activePlanModeCount > 0) {
      result.set(thread.id, activity);
    }
  }
  return result;
}

export async function getThreadPromptBannerActivity(
  deps: ThreadPromptBannerDeps,
  thread: Thread,
): Promise<PromptBannerActivityState> {
  return (
    (await buildThreadPromptBannerActivityByThreadId(deps, [thread])).get(
      thread.id,
    ) ?? {
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activePlanTurnId: null,
    }
  );
}

async function buildThreadActivityStateByThreadId(
  deps: ThreadPromptBannerDeps,
  threads: readonly Thread[],
): Promise<Map<string, ThreadActivityState>> {
  const backgroundTaskActivityByThreadId = new Map(
    (
      await listActiveBackgroundTaskCountsByThreadIds(deps.db, {
        threadIds: threads.map((thread) => thread.id),
      })
    ).map((activity) => [activity.threadId, activity]),
  );
  const promptBannerActivityByThreadId =
    await buildThreadPromptBannerActivityByThreadId(deps, threads);
  const result = new Map<string, ThreadActivityState>();
  for (const thread of threads) {
    const backgroundActivity = backgroundTaskActivityByThreadId.get(thread.id);
    const promptBannerActivity = promptBannerActivityByThreadId.get(thread.id);
    if (!backgroundActivity && !promptBannerActivity) {
      continue;
    }
    result.set(thread.id, {
      activeBackgroundAgentCount:
        backgroundActivity?.activeBackgroundAgentCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundAgentCount,
      activeBackgroundCommandCount:
        backgroundActivity?.activeBackgroundCommandCount ??
        EMPTY_THREAD_ACTIVITY.activeBackgroundCommandCount,
      activeGoalCount:
        promptBannerActivity?.activeGoalCount ??
        EMPTY_THREAD_ACTIVITY.activeGoalCount,
      activePlanModeCount:
        promptBannerActivity?.activePlanModeCount ??
        EMPTY_THREAD_ACTIVITY.activePlanModeCount,
      activeWorkflowCount:
        backgroundActivity?.activeWorkflowCount ??
        EMPTY_THREAD_ACTIVITY.activeWorkflowCount,
    });
  }
  return result;
}

/**
 * Whether each thread has queued work, from one grouped count over live queued
 * rows. Threads with an empty queue are absent, so the caller fills "none".
 *
 * A failure outranks a plain wait: a row that failed to go out is the one the
 * reader has to do something about, and a thread can easily hold both.
 */
async function buildThreadQueuedWorkByThreadId(
  deps: ThreadRuntimeDisplayDeps,
  threads: readonly Thread[],
): Promise<Map<string, ThreadQueuedWork>> {
  const result = new Map<string, ThreadQueuedWork>();
  for (const counts of await listQueuedThreadMessageCountsByThreadIds(deps.db, {
    threadIds: threads.map((thread) => thread.id),
  })) {
    if (counts.queuedMessageCount === 0) continue;
    result.set(
      counts.threadId,
      counts.failedQueuedMessageCount > 0 ? "failed" : "waiting",
    );
  }
  return result;
}

export async function toThreadListEntryResponses(
  deps: ThreadPromptBannerDeps,
  args: ToThreadListEntryResponsesArgs,
): Promise<ThreadListEntry[]> {
  const activityByThreadId = await buildThreadActivityStateByThreadId(
    deps,
    args.threads,
  );
  const activeHostIds = [
    ...new Set(
      args.threads.flatMap((thread) =>
        thread.status === "active" && thread.environmentHostId !== null
          ? [thread.environmentHostId]
          : [],
      ),
    ),
  ];
  const connectedActiveHostIds = new Set(
    (
      await Promise.all(
        activeHostIds.map(async (value, index, array) =>
          (await (async (hostId) =>
            await hasOpenDaemonSessionForHost(deps, hostId))(value))
            ? [value]
            : [],
        ),
      )
    ).flat(),
  );
  const latestClosedSessionByHostId = new Map(
    (
      await listLatestClosedSessionsForHosts(deps.db, {
        hostIds: activeHostIds.filter(
          (hostId) => !connectedActiveHostIds.has(hostId),
        ),
      })
    ).map((session) => [session.hostId, session]),
  );
  const queuedWorkByThreadId = await buildThreadQueuedWorkByThreadId(
    deps,
    args.threads,
  );
  return await Promise.all(
    args.threads.map(async (thread) => {
      const entry = toThreadListEntryResponseFromLatestSession({
        activity: activityByThreadId.get(thread.id) ?? EMPTY_THREAD_ACTIVITY,
        queuedWork: queuedWorkByThreadId.get(thread.id) ?? "none",
        hostConnected:
          thread.environmentHostId !== null &&
          connectedActiveHostIds.has(thread.environmentHostId),
        latestClosedSession:
          thread.environmentHostId === null
            ? null
            : (latestClosedSessionByHostId.get(thread.environmentHostId) ??
              null),
        now: args.now,
        thread,
      });
      return thread.environmentHostId === null &&
        (thread.status === "pending" || thread.status === "starting")
        ? {
            ...entry,
            environmentHostId: await intendedThreadHostId(deps, thread.id),
          }
        : entry;
    }),
  );
}

function toThreadListEntryResponseFromLatestSession(
  args: ToThreadListEntryResponseFromLatestSessionArgs,
): ThreadListEntry {
  const thread = toPublicThread(args.thread);
  return {
    ...thread,
    activity: args.activity,
    queuedWork: args.queuedWork,
    pinSortKey: args.thread.pinSortKey,
    environmentBranchName: args.thread.environmentBranchName,
    environmentHostId: args.thread.environmentHostId,
    environmentName: args.thread.environmentName,
    environmentPath: args.thread.environmentPath,
    environmentProviderId: args.thread.environmentProviderId,
    environmentIsWorktree: args.thread.environmentIsWorktree,
    environmentWorkspaceDisplayKind: resolveEnvironmentWorkspaceDisplayKind({
      environmentProviderId: args.thread.environmentProviderId,
      isWorktree: args.thread.environmentIsWorktree,
    }),
    hasPendingInteraction: args.thread.hasPendingInteraction,
    runtime: resolveThreadRuntimeStateFromLatestSession({
      environmentHostId: args.thread.environmentHostId,
      hostConnected: args.hostConnected,
      latestClosedSession: args.latestClosedSession,
      now: args.now,
      status: thread.status,
    }),
  };
}
