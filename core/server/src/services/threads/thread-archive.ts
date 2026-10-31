import {
  cancelProviderEnvironmentCreation,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import {
  removeCreatingMachine,
  sweepProviderMachine,
} from "../machines/provider-orchestration.js";
import {
  listLiveThreadsInEnvironment,
  listLifecycleThreadDependents,
  archiveThread,
  getEnvironment,
  listNonDeletedChildThreads,
  listNonDeletedHiddenSourceThreads,
} from "@hyperfide/db";
import type { EnvironmentRow } from "@hyperfide/db";
import type { Thread } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../system/event-pruning.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  requestThreadStopForCurrentState,
} from "./thread-lifecycle.js";
import {
  archiveUndoGraceKeepsTerminals,
  archiveUndoGraceKeepsTurnRunning,
} from "./archive-undo-grace.js";
import { archiveThreadAndReleaseChildren } from "./thread-ownership.js";
import { resolveThreadHostCommandEnvironment } from "./thread-command-environment.js";

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  environment: ArchiveThreadEnvironment | null;
  thread: Pick<Thread, "environmentId" | "id" | "status">;
}

interface ArchiveEnvironmentThreadsArgs {
  environment: EnvironmentRow;
}

interface ArchiveThreadAndChildrenArgs {
  parentThread: Thread;
}

async function archiveThreadWithLifecycleEffects(
  deps: AppDeps,
  args: ArchiveThreadWithLifecycleEffectsArgs,
): Promise<Thread | null> {
  const archivedThread = await archiveThreadAndReleaseChildren(deps, {
    threadId: args.thread.id,
  });
  if (!archivedThread) {
    return null;
  }

  const now = Date.now();
  if (!archiveUndoGraceKeepsTerminals(archivedThread, now)) {
    await deps.terminalSessions.closeArchivedThreadTerminals({
      threadId: archivedThread.id,
    });
  }
  if (!archiveUndoGraceKeepsTurnRunning(archivedThread, now)) {
    await requestThreadStopForCurrentState(
      deps,
      archivedThread,
      args.environment,
    );
  }
  await dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
    threadId: archivedThread.id,
  });
  resetActiveThreadEventPruningState(archivedThread.id);
  await pruneThreadEventHistoryBestEffort(deps, {
    mode: "archived",
    threadId: archivedThread.id,
  });
  void cancelProviderEnvironmentCreation(deps, archivedThread.id).catch(
    (error) =>
      deps.logger.warn({ error }, "Environment launch cancellation failed"),
  );
  void removeCreatingMachine(deps, archivedThread.id).catch((error) =>
    deps.logger.warn({ error }, "Machine launch cancellation failed"),
  );
  if (archivedThread.environmentId !== null)
    void sweepProviderEnvironment(deps, archivedThread.environmentId).catch(
      (error) => deps.logger.warn({ error }, "Environment retirement failed"),
    );
  if (args.environment !== null) {
    void sweepProviderMachine(deps, args.environment.hostId).catch((error) =>
      deps.logger.warn({ error }, "Machine retirement failed"),
    );
  }
  emitPluginThreadArchived(archivedThread);

  return archivedThread;
}

export async function archiveEnvironmentThreads(
  deps: AppDeps,
  args: ArchiveEnvironmentThreadsArgs,
): Promise<string[]> {
  const roots = await listLiveThreadsInEnvironment(deps.db, {
    environmentId: args.environment.id,
  });
  return await archiveThreadTrees(deps, roots, async (thread) =>
    thread.environmentId === null
      ? null
      : await getEnvironment(deps.db, thread.environmentId),
  );
}

export async function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): Promise<string[]> {
  const environment = await resolveThreadHostCommandEnvironment({
    db: deps.db,
    thread: args.parentThread,
  });
  return await archiveThreadTrees(deps, [args.parentThread], async (thread) =>
    thread.id === args.parentThread.id
      ? environment
      : thread.environmentId === null
        ? null
        : await getEnvironment(deps.db, thread.environmentId),
  );
}

async function archiveThreadTrees(
  deps: AppDeps,
  roots: Thread[],
  resolveEnvironment: (
    thread: ArchiveThreadWithLifecycleEffectsArgs["thread"],
  ) =>
    | ArchiveThreadEnvironment
    | null
    | Promise<ArchiveThreadEnvironment | null>,
): Promise<string[]> {
  const threads = await listArchiveCandidates(deps.db, roots);
  for (const root of roots) await archiveThread(deps.db, deps.hub, root.id);
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) {
      if (!archiveUndoGraceKeepsTurnRunning(thread, Date.now()))
        await requestThreadStopForCurrentState(
          deps,
          thread,
          thread.environmentId === null
            ? null
            : await resolveEnvironment(thread),
        );
      continue;
    }
    const environment = await resolveEnvironment(thread);
    const result = await archiveThreadWithLifecycleEffects(deps, {
      environment,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  return archivedThreadIds;
}

export async function countUnarchivedThreadDescendants(
  db: AppDeps["db"],
  thread: Thread,
): Promise<number> {
  return (await listArchiveCandidates(db, [thread])).filter(
    (candidate) =>
      candidate.id !== thread.id &&
      candidate.visibility === "visible" &&
      candidate.deletedAt === null &&
      candidate.archivedAt === null,
  ).length;
}

async function listArchiveCandidates(db: AppDeps["db"], roots: Thread[]) {
  type ArchiveCandidate = Pick<
    Thread,
    | "id"
    | "environmentId"
    | "status"
    | "archivedAt"
    | "deletedAt"
    | "visibility"
  >;
  const pending: { thread: ArchiveCandidate; expanded: boolean }[] = [...roots]
    .reverse()
    .map((thread) => ({ thread, expanded: false }));
  const visited = new Set<string>();
  const threads: ArchiveCandidate[] = [];

  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) {
      break;
    }
    const { thread, expanded } = entry;
    if (expanded) {
      threads.push(thread);
      continue;
    }
    if (visited.has(thread.id)) {
      continue;
    }
    visited.add(thread.id);
    pending.push({ thread, expanded: true });
    const descendants = [
      ...(await listLifecycleThreadDependents(db, thread.id)),
      ...(await listNonDeletedChildThreads(db, {
        parentThreadId: thread.id,
      })),
      ...(await listNonDeletedHiddenSourceThreads(db, {
        sourceThreadId: thread.id,
      })),
    ];
    for (const descendant of descendants.reverse()) {
      pending.push({ thread: descendant, expanded: false });
    }
  }
  return threads;
}
