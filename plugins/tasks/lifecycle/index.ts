import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { publishCommentsChanged, type TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import { createSystemComment, publishThreadsChanged } from "../delegate";
import { errorMessage } from "../shared/errors";

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>(["completed"]);

type SdkThread = Awaited<ReturnType<HyperfidePluginApi["sdk"]["threads"]["get"]>>;

function liveStatusFromThread(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.status === "error") return "failed";
  if (thread.deletedAt !== null) return "completed";

  switch (thread.status) {
    case "pending":
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
  }
}

function trackedThreads(store: TasksApiStore): TaskThread[] {
  const tracked: TaskThread[] = [];
  for (const task of store.tasks.listTasks()) {
    for (const thread of store.tasks.listTaskThreads(task.id)) {
      tracked.push(thread);
    }
  }
  return tracked;
}

function statusCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  const outcome =
    liveStatus === "completed" ? "completed — final message posted" : "failed";
  return `Thread "${thread.title}" ${outcome} · ${thread.threadId}`;
}

function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function transitionThread(
  hyperfide: HyperfidePluginApi,
  store: TasksApiStore,
  thread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  if (
    thread.liveStatus === liveStatus ||
    TERMINAL_LIVE_STATUSES.has(thread.liveStatus)
  ) {
    return;
  }

  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body: statusCommentBody(thread, liveStatus),
      });
    }
  });

  publishThreadsChanged(hyperfide, thread.taskId);
  publishCommentsChanged(hyperfide, thread.taskId);
}

function transitionTrackedThread(
  hyperfide: HyperfidePluginApi,
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of store.tasks.listTaskThreadsByThreadId(threadId)) {
    transitionThread(hyperfide, store, thread, liveStatus);
  }
}

async function reconcileTrackedThread(
  hyperfide: HyperfidePluginApi,
  store: TasksApiStore,
  trackedThread: TaskThread,
): Promise<void> {
  try {
    const thread = await hyperfide.sdk.threads.get({
      threadId: trackedThread.threadId,
    });
    transitionThread(hyperfide, store, trackedThread, liveStatusFromThread(thread));
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      transitionThread(hyperfide, store, trackedThread, "completed");
      return;
    }
    hyperfide.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${errorMessage(
        error,
      )}`,
    );
  }
}

async function reconcileTrackedThreads(
  hyperfide: HyperfidePluginApi,
  store: TasksApiStore,
): Promise<void> {
  const nonTerminalThreads = trackedThreads(store).filter(
    (thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );

  for (const trackedThread of nonTerminalThreads) {
    await reconcileTrackedThread(hyperfide, store, trackedThread);
  }
}

export async function registerLifecycle(
  hyperfide: HyperfidePluginApi,
  store: TasksApiStore,
): Promise<void> {
  hyperfide.events.on("thread.created", ({ thread }) => {
    transitionTrackedThread(hyperfide, store, thread.id, liveStatusFromThread(thread));
  });
  hyperfide.events.on("thread.active", ({ thread }) => {
    transitionTrackedThread(hyperfide, store, thread.id, "working");
  });
  hyperfide.events.on("thread.idle", ({ thread }) => {
    transitionTrackedThread(hyperfide, store, thread.id, "idle");
  });
  hyperfide.events.on("thread.failed", ({ thread }) => {
    transitionTrackedThread(hyperfide, store, thread.id, "failed");
  });
  hyperfide.events.on("thread.deleted", ({ thread }) => {
    transitionTrackedThread(hyperfide, store, thread.id, "completed");
  });

  await reconcileTrackedThreads(hyperfide, store);
}
