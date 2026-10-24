import { eq } from "drizzle-orm";
import {
  closeSession,
  hostDaemonSessions,
  listActiveHostThreads,
  listHostThreadIds,
  type HostDaemonSessionRow,
} from "@hyperfide/db";
import type {
  HostDaemonActiveThread,
  HostDaemonSessionCloseReason,
} from "@hyperfide/host-daemon-contract";
import { HOST_RECONNECT_GRACE_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../types.js";
import {
  interruptActiveThreadsForHost,
  reconcileDaemonReportedThreads,
} from "../services/threads/thread-lifecycle.js";
import { buildThreadStatusChangeMetadataByThreadId } from "../services/threads/thread-runtime-display.js";
import { settleDanglingBackgroundTasks } from "../services/threads/background-task-reconciliation.js";
import { interruptEnvironmentProvisioningForHost } from "../services/environments/environment-engine.js";

const DAEMON_RESTARTED_PENDING_INTERACTION_REASON =
  "Host daemon restarted while awaiting user interaction; retry the thread to continue";
const DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON =
  "Host daemon disconnected while awaiting user interaction; retry the thread to continue";
const DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON =
  "Host daemon restarted while preparing the workspace. Retry provisioning to continue.";
const DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON =
  "The connection to the host was lost while preparing the workspace. Retry provisioning to continue.";

type HostSessionOpenedDeps = LoggedPendingInteractionWorkSessionDeps;
type DaemonSocketClosedDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "sharedPorts">;
type LostHostWorkDeps = LoggedPendingInteractionWorkSessionDeps;

interface HandleHostSessionOpenedArgs {
  activeThreads: HostDaemonActiveThread[];
  hostId: string;
  openedSession: HostDaemonSessionRow;
  previousSession: HostDaemonSessionRow | null;
  undeliveredEventThreadIds: string[];
}

interface HandleDaemonSocketClosedArgs {
  sessionId: string;
}

interface HandleDaemonSessionLostArgs {
  reason: Extract<
    HostDaemonSessionCloseReason,
    "daemon-disconnect" | "expired"
  >;
  sessionId: string;
}

interface HandleHostRemovedArgs {
  hostId: string;
  sessionId: string;
}

export async function handleHostSessionOpened(
  deps: HostSessionOpenedDeps,
  args: HandleHostSessionOpenedArgs,
): Promise<void> {
  deps.logger.info(
    {
      sessionId: args.openedSession.id,
      hostId: args.hostId,
      replacedSessionId: args.previousSession?.id ?? null,
    },
    "Session opened",
  );

  const sameDaemonInstance =
    args.previousSession?.instanceId === args.openedSession.instanceId;
  if (
    args.previousSession &&
    args.previousSession.id !== args.openedSession.id
  ) {
    deps.hub.cancelPendingDaemonDisconnect(args.previousSession.id);

    if (args.previousSession.status === "active") {
      if (sameDaemonInstance) {
        deps.hub.closeDaemonSessionSocket(args.previousSession.id, "replaced");
      } else {
        deps.hub.closeDaemonSession(args.previousSession.id, "replaced");
      }
      await deps.terminalSessions.handleDaemonSessionClosed({
        sessionId: args.previousSession.id,
      });
    }

    if (!sameDaemonInstance) {
      await interruptEnvironmentProvisioningForHost(deps, {
        hostId: args.hostId,
        reason: DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON,
      });
      await interruptPendingInteractionsForHostThreads(deps, {
        hostId: args.hostId,
        reason: DAEMON_RESTARTED_PENDING_INTERACTION_REASON,
      });
      await interruptActiveThreadsForHost(deps, {
        includeStopping: false,
        hostId: args.hostId,
        reason: "host-daemon-restarted",
      });
      await settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
    }
  }

  await reconcileDaemonReportedThreads(deps, {
    activeThreadIds: args.activeThreads.map((thread) => thread.threadId),
    hostId: args.hostId,
    sameDaemonInstance,
    undeliveredEventThreadIds: args.undeliveredEventThreadIds,
  });
}

export async function handleDaemonSocketClosed(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): Promise<void> {
  deps.logger.info({ sessionId: args.sessionId }, "Daemon WebSocket closed");
  await handleDaemonSessionLost(deps, {
    reason: "daemon-disconnect",
    sessionId: args.sessionId,
  });
}

export async function handleDaemonSocketOpened(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  args: { hostId: string },
): Promise<void> {
  await notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

export async function handleDaemonSessionSilent(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSocketClosedArgs,
): Promise<void> {
  deps.logger.warn(
    { leaseTimeoutMs: LEASE_TIMEOUT_MS, sessionId: args.sessionId },
    "Daemon sent nothing within its lease; closing its socket",
  );
  deps.hub.closeDaemonSession(args.sessionId, "expired");
  await handleDaemonSessionLost(deps, {
    reason: "expired",
    sessionId: args.sessionId,
  });
}

async function handleDaemonSessionLost(
  deps: DaemonSocketClosedDeps,
  args: HandleDaemonSessionLostArgs,
): Promise<void> {
  deps.hub.unregisterDaemon(args.sessionId);
  deps.sharedPorts.clearHostConnectCapability(args.sessionId);

  const session = await deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (!session || session.status !== "active") {
    return;
  }
  await deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });

  await closeSession(deps.db, deps.hub, args.sessionId, args.reason);

  await notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
  if (args.reason === "expired") {
    return;
  }
  deps.hub.scheduleDaemonDisconnect(
    args.sessionId,
    HOST_RECONNECT_GRACE_MS,
    async () => {
      if (deps.hub.hasDaemonForHost(session.hostId)) {
        return;
      }
      await deps.hub.notifyHost(session.hostId, ["host-disconnected"]);
      await notifyHostThreadRuntimeStatusChanged(deps, session.hostId);
    },
  );
}

export async function handleHostRemoved(
  deps: Omit<DaemonSocketClosedDeps, "sharedPorts">,
  args: HandleHostRemovedArgs,
): Promise<void> {
  const session = await deps.db
    .select()
    .from(hostDaemonSessions)
    .where(eq(hostDaemonSessions.id, args.sessionId))
    .get();
  if (
    !session ||
    session.status !== "active" ||
    session.hostId !== args.hostId
  ) {
    return;
  }

  await closeSession(deps.db, deps.hub, args.sessionId, "expired");
  deps.hub.closeDaemonSession(args.sessionId, "expired");
  await deps.terminalSessions.handleDaemonSessionClosed({
    sessionId: args.sessionId,
  });
  await settleRemovedHostWork(deps, { hostId: args.hostId });
}

export async function settleRemovedHostWork(
  deps: Omit<DaemonSocketClosedDeps, "sharedPorts">,
  args: { hostId: string },
): Promise<void> {
  await interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: "The machine was removed",
  });
  await interruptEnvironmentProvisioningForHost(deps, {
    hostId: args.hostId,
    reason: DAEMON_RESTARTED_ENVIRONMENT_PROVISIONING_REASON,
  });
  await interruptActiveThreadsForHost(deps, {
    includeStopping: true,
    hostId: args.hostId,
    reason: "host-removed",
  });
  await settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
  await notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
}

interface DisconnectImportedDaemonSessionsArgs {
  sessions: ReadonlyArray<{ hostId: string; id: string }>;
}

export async function disconnectImportedDaemonSessions(
  deps: LostHostWorkDeps,
  args: DisconnectImportedDaemonSessionsArgs,
): Promise<void> {
  if (args.sessions.length === 0) {
    return;
  }
  const hostIds = new Set<string>();
  for (const session of args.sessions) {
    await deps.terminalSessions.handleDaemonSessionClosed({
      sessionId: session.id,
    });
    await closeSession(deps.db, deps.hub, session.id, "daemon-disconnect");
    hostIds.add(session.hostId);
  }
  for (const hostId of hostIds) {
    await settleLostHostWork(deps, { hostId });
  }
  deps.logger.info(
    { hosts: hostIds.size, sessions: args.sessions.length },
    "Closed the daemon sessions an imported server snapshot left active",
  );
}

async function settleLostHostWork(
  deps: LostHostWorkDeps,
  args: { hostId: string },
): Promise<void> {
  await interruptPendingInteractionsForHostThreads(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_PENDING_INTERACTION_REASON,
  });
  await settleDanglingBackgroundTasks(deps, { hostId: args.hostId });
  await notifyHostThreadRuntimeStatusChanged(deps, args.hostId);
  await interruptActiveThreadsForHost(deps, {
    includeStopping: false,
    hostId: args.hostId,
    reason: "host-daemon-restarted",
    cause: "host-connection-lost",
  });
  await interruptEnvironmentProvisioningForHost(deps, {
    hostId: args.hostId,
    reason: DAEMON_DISCONNECTED_ENVIRONMENT_PROVISIONING_REASON,
  });
}

async function notifyHostThreadRuntimeStatusChanged(
  deps: Pick<AppDeps, "db" | "hub" | "providerRegistry">,
  hostId: string,
): Promise<void> {
  const metadataByThreadId = await buildThreadStatusChangeMetadataByThreadId(
    deps,
    {
      environmentHostId: hostId,
      threads: await listActiveHostThreads(deps.db, { hostId }),
    },
  );
  for (const threadId of await listHostThreadIds(deps.db, { hostId })) {
    await deps.hub.notifyThread(
      threadId,
      ["status-changed"],
      metadataByThreadId.get(threadId),
    );
  }
}

async function interruptPendingInteractionsForHostThreads(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  args: { hostId: string; reason: string },
): Promise<void> {
  await deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
    threadIds: await listHostThreadIds(deps.db, { hostId: args.hostId }),
    reason: args.reason,
  });
}
