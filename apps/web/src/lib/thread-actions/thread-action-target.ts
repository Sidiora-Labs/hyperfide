import type { Thread, ThreadListEntry } from "@hyperfide/domain";
import { isThreadRead } from "@hyperfide/client-core";
import type { PluginThreadActionTarget } from "@hyperfide/plugin-sdk";

export function toThreadActionTarget(
  thread: Thread,
  environment: PluginThreadActionTarget["environment"],
): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: !isThreadRead(thread),
    status: thread.status,
    environment,
  };
}

export function threadListEntryActionTarget(
  entry: ThreadListEntry,
): PluginThreadActionTarget {
  return toThreadActionTarget(
    entry,
    entry.environmentId === null
      ? null
      : { id: entry.environmentId, path: entry.environmentPath },
  );
}
