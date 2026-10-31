import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";

export interface QueuedRetry {
  id: string;
  threadId: string;
  sendAt: number | null;
}

export async function listQueuedRetries(
  hyperfide: HyperfidePluginApi,
  threadId?: string,
): Promise<QueuedRetry[]> {
  const rows = await hyperfide.sdk.threads.queue.list(
    threadId === undefined ? {} : { threadId },
  );
  return rows
    .filter((row) => row.payload.kind === "retry")
    .map((row) => ({
      id: row.id,
      threadId: row.threadId,
      sendAt: row.sendAt,
    }));
}

export async function findQueuedRetry(
  hyperfide: HyperfidePluginApi,
  threadId: string,
): Promise<QueuedRetry | null> {
  const rows = await listQueuedRetries(hyperfide, threadId);
  return rows[0] ?? null;
}
