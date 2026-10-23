import type { ThreadStatus } from "@hyperfide/domain";

type PreStartThreadStatus = Extract<ThreadStatus, "starting">;

export function isPreStartThreadStatus(
  status: ThreadStatus,
): status is PreStartThreadStatus {
  return status === "starting";
}
