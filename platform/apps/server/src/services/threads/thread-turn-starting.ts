import { getThread, type ClaimedQueuedThreadMessageRow } from "@hyperfide/db";
import type { Thread, ThreadQueuedMessage } from "@hyperfide/domain";
import type { AppDeps } from "../../types.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import {
  recordQueuedMessageWait,
  type QueuedDispatchMessage,
} from "./queue-waits.js";
import { getActiveTurnId } from "./thread-events.js";

type TurnStartingDeps = Pick<AppDeps, "db" | "hub" | "logger">;

export type QueueInputForStartingTurnResult =
  | { kind: "dispatched" }
  | { kind: "queued"; entry: ThreadQueuedMessage }
  | { kind: "retry"; thread: Thread | null };

export async function queueInputForStartingTurn(
  deps: TurnStartingDeps,
  args: {
    claimed: readonly ClaimedQueuedThreadMessageRow[] | null;
    input: QueuedDispatchMessage;
    threadId: string;
  },
): Promise<QueueInputForStartingTurnResult> {
  if (args.input.input.length === 0) return { kind: "dispatched" };
  const notifications = new NotificationBuffer();
  const outcome: QueueInputForStartingTurnResult = await deps.db.transaction(
    async (tx) => {
      const thread = await getThread(tx, args.threadId);
      if (
        !thread ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        thread.status !== "active"
      ) {
        return { kind: "retry", thread };
      }
      if ((await getActiveTurnId({ db: tx }, args.threadId)) !== null) {
        return { kind: "retry", thread };
      }
      const entry = await recordQueuedMessageWait(
        { db: tx, hub: notifications },
        {
          thread,
          message: args.input,
          waitingOn: { kind: "turn-starting" },
          sendAt: null,
          claimed: args.claimed,
        },
      );
      return entry === null
        ? { kind: "dispatched" }
        : { kind: "queued", entry };
    },
    { behavior: "immediate" },
  );
  await notifications.flushInto(deps.hub);
  if (outcome.kind === "queued") {
    deps.logger.info(
      { queuedMessageId: outcome.entry.id, threadId: args.threadId },
      "Queued input until the current turn starts",
    );
  }
  return outcome;
}
