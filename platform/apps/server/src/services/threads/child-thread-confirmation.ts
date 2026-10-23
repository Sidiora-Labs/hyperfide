import { countNonDeletedAssignedChildThreads } from "@hyperfide/db";
import type { Thread } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

type ChildThreadsDestructiveAction = "archive" | "delete";

interface RequireChildThreadsConfirmationRequest {
  action: ChildThreadsDestructiveAction;
  confirmed: boolean;
  deps: AppDeps;
  thread: Thread;
}

function childThreadsConfirmationMessage(
  action: ChildThreadsDestructiveAction,
): string {
  const actionLabel = action === "archive" ? "Archiving" : "Deleting";
  return `${actionLabel} this thread requires confirmation because it has non-deleted child threads.`;
}

export async function requireChildThreadsConfirmation({
  action,
  confirmed,
  deps,
  thread,
}: RequireChildThreadsConfirmationRequest): Promise<void> {
  if (confirmed) {
    return;
  }

  const nonDeletedChildCount = await countNonDeletedAssignedChildThreads(
    deps.db,
    {
      parentThreadId: thread.id,
    },
  );
  if (nonDeletedChildCount === 0) {
    return;
  }

  throw new ApiError(
    409,
    "child_threads_confirmation_required",
    childThreadsConfirmationMessage(action),
  );
}
