import { getLatestSessionForHost } from "@hyperfide/db";
import { ApiError } from "../../errors.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { WorkSessionDeps } from "../../types.js";
import {
  requireConnectedHostSession,
  requireEnvironment,
  requirePublicThread,
} from "../lib/entity-lookup.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";

interface RequireThreadStoragePathArgs {
  hostId: string;
  threadId: string;
}

export async function requireThreadStoragePath(
  deps: WorkSessionDeps,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = await getLatestSessionForHost(deps.db, {
    hostId: args.hostId,
  });
  if (session === null) {
    throw new ApiError(
      502,
      "host_unavailable",
      "The host has no known storage location",
      false,
    );
  }
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
}

export async function requireLiveThreadStoragePath(
  deps: WorkSessionDeps,
  args: RequireThreadStoragePathArgs,
): Promise<string> {
  const session = await requireConnectedHostSession(deps, args.hostId);
  return joinHostPathSegments(session.dataDir, "thread-storage", args.threadId);
}

export interface ThreadStorageTarget {
  hostId: string;
  storagePath: string;
}

export async function requireThreadEnvironmentHostId(
  deps: Pick<WorkSessionDeps, "db">,
  threadId: string,
): Promise<string> {
  const thread = await requirePublicThread(deps.db, threadId);
  if (!thread.environmentId) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
  }
  return (await requireEnvironment(deps.db, thread.environmentId)).hostId;
}

export async function requireThreadStorageTarget(
  deps: WorkSessionDeps,
  threadId: string,
): Promise<ThreadStorageTarget> {
  const hostId = await requireThreadEnvironmentHostId(deps, threadId);
  return {
    hostId,
    storagePath: await requireThreadStoragePath(deps, { hostId, threadId }),
  };
}
