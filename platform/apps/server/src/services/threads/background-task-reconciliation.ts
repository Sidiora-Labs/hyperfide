import { z } from "zod";
import {
  getLatestThreadSequence,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  type DbNotifier,
  type DbTransaction,
  type OpenBackgroundTaskItemRow,
} from "@hyperfide/db";
import {
  backgroundTaskItemStatus,
  isSettledBackgroundTaskStatus,
  threadEventBackgroundTaskItemSchema,
  threadScope,
} from "@hyperfide/domain";
import type { ThreadEventBackgroundTaskItem } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

interface SettleDanglingBackgroundTasksArgs {
  hostId: string;
}

type SettleDanglingBackgroundTasksDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

const storedBackgroundTaskEventDataSchema = z.object({
  item: threadEventBackgroundTaskItemSchema,
});

function parseStoredBackgroundTaskItem(
  row: OpenBackgroundTaskItemRow,
): ThreadEventBackgroundTaskItem | null {
  try {
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(
      JSON.parse(row.data),
    );
    return parsed.success ? parsed.data.item : null;
  } catch {
    return null;
  }
}

export async function settleDanglingBackgroundTasks(
  deps: SettleDanglingBackgroundTasksDeps,
  args: SettleDanglingBackgroundTasksArgs,
): Promise<void> {
  const rows = await listOpenBackgroundTaskItemRowsForHost(deps.db, {
    hostId: args.hostId,
  });
  if (rows.length === 0) {
    return;
  }

  const settledThreadIds = new Set<string>();
  await deps.db.transaction(
    async (tx) => {
      for (const threadId of await appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        rows,
      )) {
        settledThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
  );

  for (const threadId of settledThreadIds) {
    await deps.hub.notifyThread(threadId, ["events-appended"], {
      timelineSequence: await getLatestThreadSequence(deps.db, {
        threadId: threadId,
      }),
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

export async function settleDanglingBackgroundTasksForStoppedThreadInTransaction(
  deps: SettleDanglingBackgroundTasksTransactionDeps,
  args: { threadId: string },
): Promise<void> {
  const rows = await listOpenBackgroundTaskItemRowsForThread(deps.db, args);
  const settledThreadIds = await appendDanglingBackgroundTaskCompletions(
    deps,
    rows,
  );
  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      timelineSequence: await getLatestThreadSequence(deps.db, {
        threadId: threadId,
      }),
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

async function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  rows: readonly OpenBackgroundTaskItemRow[],
): Promise<Set<string>> {
  const settledThreadIds = new Set<string>();
  for (const row of rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const taskStatus = isSettledBackgroundTaskStatus(item.taskStatus)
      ? item.taskStatus
      : "stopped";
    await appendThreadEventsInTransaction(deps.db, [
      {
        threadId: row.threadId,
        environmentId: row.environmentId,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: {
            ...item,
            status: backgroundTaskItemStatus(taskStatus),
            taskStatus,
          },
        },
      },
    ]);
    settledThreadIds.add(row.threadId);
  }
  return settledThreadIds;
}
