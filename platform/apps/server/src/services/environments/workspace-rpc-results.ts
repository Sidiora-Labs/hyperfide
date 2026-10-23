import type { ThreadGitDiffResponse, WorkspaceStatus } from "@hyperfide/domain";
import type {
  HostDaemonOnlineRpcResult,
  WorkspaceResolutionFailure,
} from "@hyperfide/host-daemon-contract";
import { ApiError } from "../../errors.js";

type WorkspaceStatusCommandResult =
  HostDaemonOnlineRpcResult<"workspace.status">;
type WorkspaceDiffCommandResult = HostDaemonOnlineRpcResult<"workspace.diff">;

function throwWorkspaceUnavailable(failure: WorkspaceResolutionFailure): never {
  throw new ApiError(409, "workspace_unavailable", failure.message, {
    details: { kind: "workspace_unavailable", failure },
  });
}

export function requireAvailableWorkspaceStatus(
  result: WorkspaceStatusCommandResult,
): WorkspaceStatus {
  if (result.outcome === "available") {
    return result.workspaceStatus;
  }
  throwWorkspaceUnavailable(result.failure);
}

export function requireAvailableWorkspaceDiff(
  result: WorkspaceDiffCommandResult,
): ThreadGitDiffResponse {
  if (result.outcome === "available") {
    return result.diff;
  }
  throwWorkspaceUnavailable(result.failure);
}
