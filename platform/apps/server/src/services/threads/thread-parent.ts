import { getThread, listNonDeletedChildThreads } from "@hyperfide/db";
import type { Thread, ThreadEventTurnStatus } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import { throwParentThreadInvalid } from "../lib/lifecycle-api-errors.js";

const MAX_THREAD_HIERARCHY_DEPTH = 4;

export type ParentNotificationOutcome =
  | ThreadEventTurnStatus
  | "needs-attention";

export function isParentNotifiableChildThread<
  T extends Pick<
    Thread,
    "parentThreadId" | "originKind" | "parentNotifications"
  >,
>(
  thread: T,
  outcome: ParentNotificationOutcome,
): thread is T & { parentThreadId: string } {
  if (thread.parentThreadId === null || thread.originKind !== null) {
    return false;
  }
  switch (thread.parentNotifications) {
    case "auto":
      return true;
    case "stuck":
      return outcome !== "completed";
    case "off":
      return false;
  }
}

export type ParentThread = Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
> &
  Partial<Pick<Thread, "originKind">>;

interface IsLiveParentThreadArgs {
  parentThread: ParentThread | null;
}

interface AssertValidParentThreadArgs {
  childThreadId?: string;
  parentThreadId: string;
}

interface ResolveParentDepthArgs {
  childThreadId?: string;
  parentThread: ParentThread;
}

interface ResolveThreadSubtreeDepthArgs {
  threadId: string;
  visitedThreadIds: Set<string>;
}

export function isLiveParentThread(args: IsLiveParentThreadArgs): boolean {
  return (
    args.parentThread !== null &&
    args.parentThread.archivedAt === null &&
    args.parentThread.deletedAt === null
  );
}

async function resolveParentDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveParentDepthArgs,
): Promise<number> {
  let depth = 0;
  let parentThread: ParentThread | null = args.parentThread;
  const visitedThreadIds = new Set<string>();

  while (parentThread !== null) {
    if (args.childThreadId && parentThread.id === args.childThreadId) {
      throwParentThreadInvalid(
        parentThread.id === args.parentThread.id ? "self" : "cycle",
      );
    }
    if (visitedThreadIds.has(parentThread.id)) {
      throwParentThreadInvalid("cycle");
    }
    visitedThreadIds.add(parentThread.id);
    depth += 1;

    if (parentThread.parentThreadId === null) {
      return depth;
    }

    parentThread = await getThread(deps.db, parentThread.parentThreadId);
  }

  return depth;
}

async function resolveThreadSubtreeDepth(
  deps: Pick<AppDeps, "db">,
  args: ResolveThreadSubtreeDepthArgs,
): Promise<number> {
  if (args.visitedThreadIds.has(args.threadId)) {
    throwParentThreadInvalid("cycle");
  }
  args.visitedThreadIds.add(args.threadId);

  const childThreads = await listNonDeletedChildThreads(deps.db, {
    parentThreadId: args.threadId,
  });
  let maxChildDepth = 0;
  for (const childThread of childThreads) {
    const childDepth = await resolveThreadSubtreeDepth(deps, {
      threadId: childThread.id,
      visitedThreadIds: args.visitedThreadIds,
    });
    maxChildDepth = Math.max(maxChildDepth, childDepth);
  }
  args.visitedThreadIds.delete(args.threadId);

  return maxChildDepth + 1;
}

interface CanThreadSpawnChildArgs {
  thread: ParentThread;
}

export async function canThreadSpawnChild(
  deps: Pick<AppDeps, "db">,
  args: CanThreadSpawnChildArgs,
): Promise<boolean> {
  const depth = await resolveParentDepth(deps, {
    parentThread: args.thread,
  });
  return depth < MAX_THREAD_HIERARCHY_DEPTH;
}

export async function assertValidParentThread(
  deps: Pick<AppDeps, "db">,
  args: AssertValidParentThreadArgs,
): Promise<Thread> {
  const parentThread = await getThread(deps.db, args.parentThreadId);
  if (parentThread === null) {
    throwParentThreadInvalid("not_found");
  }
  const liveParentThread: Thread = parentThread;

  if (liveParentThread.archivedAt !== null) {
    throwParentThreadInvalid("archived");
  }
  if (liveParentThread.deletedAt !== null) {
    throwParentThreadInvalid("deleted");
  }
  const parentDepth = await resolveParentDepth(deps, {
    childThreadId: args.childThreadId,
    parentThread: liveParentThread,
  });
  const childSubtreeDepth = args.childThreadId
    ? await resolveThreadSubtreeDepth(deps, {
        threadId: args.childThreadId,
        visitedThreadIds: new Set<string>(),
      })
    : 1;
  if (parentDepth + childSubtreeDepth > MAX_THREAD_HIERARCHY_DEPTH) {
    throwParentThreadInvalid("too_deep");
  }

  return liveParentThread;
}
