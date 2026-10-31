import {
  requestEnvironmentRemoval,
  sweepProviderEnvironment,
} from "../environments/environment-engine.js";
import { cancelAbandonedProviderCreations } from "../threads/thread-environment-providers.js";
import { eq, isNotNull, inArray } from "drizzle-orm";
import {
  deleteProject,
  getProject,
  getEnvironment,
  deletionThreadTreeIdsForProject,
  listEnvironments,
  markProjectDeleted,
  markThreadDeleted,
  projects,
  threads,
  type DbQueryConnection,
} from "@hyperfide/db";
import type { Thread, ThreadStatus } from "@hyperfide/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { deleteProjectAttachments } from "./attachments.js";
import { deferAfterResponse } from "../lib/response-deferral.js";
import { requestThreadStorageDeletion } from "../threads/thread-lifecycle.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { emitPluginThreadDeleted } from "../plugins/plugin-thread-events.js";

interface ProjectDeletionArgs {
  projectId: string;
}

interface ProjectDeletionThread {
  deletedAt: number | null;
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
}

type ProjectDeletionDeps = LoggedPendingInteractionWorkSessionDeps &
  Pick<AppDeps, "terminalSessions">;

async function isProjectDeletionActive(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): Promise<boolean> {
  return (await getProject(deps.db, projectId))?.deletedAt !== null;
}

async function listProjectDeletionThreads(
  db: DbQueryConnection,
  args: ProjectDeletionArgs,
): Promise<ProjectDeletionThread[]> {
  return await db
    .select({
      deletedAt: threads.deletedAt,
      environmentId: threads.environmentId,
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(inArray(threads.id, deletionThreadTreeIdsForProject(args.projectId)))
    .all();
}

async function tombstoneProjectThreadsForDeletion(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): Promise<{
  deletedThreads: Thread[];
  projectThreads: ProjectDeletionThread[];
}> {
  const notificationBuffer = new NotificationBuffer();
  const result = await deps.db.transaction(
    async (tx) => {
      await markProjectDeleted(tx, notificationBuffer, {
        projectId: args.projectId,
      });

      const deletedThreads: Thread[] = [];
      const threadsForDeletion = await listProjectDeletionThreads(tx, args);
      for (const thread of threadsForDeletion) {
        if (thread.deletedAt === null) {
          const deletedThread = await markThreadDeleted(
            tx,
            notificationBuffer,
            {
              threadId: thread.id,
            },
          );
          if (deletedThread) deletedThreads.push(deletedThread);
        }
      }
      return { deletedThreads, projectThreads: threadsForDeletion };
    },
    { behavior: "immediate" },
  );
  await notificationBuffer.flushInto(deps.hub);
  for (const thread of result.deletedThreads) {
    emitPluginThreadDeleted(thread);
    await cancelAbandonedProviderCreations(deps, thread.id);
  }
  return result;
}

async function hasRemainingProjectThreads(
  deps: Pick<AppDeps, "db">,
  projectId: string,
): Promise<boolean> {
  return (
    (await deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.projectId, projectId))
      .get()) !== undefined
  );
}

export async function beginProjectDeletion(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): Promise<void> {
  if (!(await getProject(deps.db, args.projectId))) {
    return;
  }

  const projectEnvironments = await listEnvironments(deps.db, {
    projectId: args.projectId,
  });
  const environmentsById = new Map(
    projectEnvironments.map((environment) => [environment.id, environment]),
  );
  const { projectThreads } = await tombstoneProjectThreadsForDeletion(
    deps,
    args,
  );
  for (const thread of projectThreads) {
    const environment = thread.environmentId
      ? (environmentsById.get(thread.environmentId) ??
        (await getEnvironment(deps.db, thread.environmentId)))
      : null;
    await requestThreadStorageDeletion(deps, thread, environment);
  }
}

export function requestProjectDeletionAdvance(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): void {
  deferAfterResponse({
    config: deps.config,
    context: {
      projectId: args.projectId,
    },
    logger: deps.logger,
    name: "Project deletion advance request",
    work: async () => {
      await advanceProjectDeletion(deps, args);
    },
  });
}

export async function advanceProjectDeletion(
  deps: ProjectDeletionDeps,
  args: ProjectDeletionArgs,
): Promise<boolean> {
  if (!(await isProjectDeletionActive(deps, args.projectId))) {
    return false;
  }

  if (!(await getProject(deps.db, args.projectId))) {
    return true;
  }

  const projectEnvironments = await listEnvironments(deps.db, {
    projectId: args.projectId,
  });
  const environmentsById = new Map(
    projectEnvironments.map((environment) => [environment.id, environment]),
  );
  const projectThreads = await listProjectDeletionThreads(deps.db, {
    projectId: args.projectId,
  });
  for (const thread of projectThreads) {
    const environment = thread.environmentId
      ? (environmentsById.get(thread.environmentId) ??
        (await getEnvironment(deps.db, thread.environmentId)))
      : null;

    if (thread.deletedAt === null) {
      const deletedThread = await markThreadDeleted(deps.db, deps.hub, {
        threadId: thread.id,
      });
      if (deletedThread) emitPluginThreadDeleted(deletedThread);
    }
    await cancelAbandonedProviderCreations(deps, thread.id);
    await deps.terminalSessions.closeDeletedThreadTerminals({
      threadId: thread.id,
    });
    await requestThreadStorageDeletion(deps, thread, environment);
  }

  if (await hasRemainingProjectThreads(deps, args.projectId)) {
    return false;
  }

  for (const environment of projectEnvironments) {
    if (environment.environmentProviderId === null) continue;
    if (!(await requestEnvironmentRemoval(deps, environment.id))) return false;
    await sweepProviderEnvironment(deps, environment.id);
    const current = await getEnvironment(deps.db, environment.id);
    if (current !== null && current.teardownStatus !== "removed") return false;
  }
  await deleteProject(deps.db, deps.hub, args.projectId);
  await deleteProjectAttachments(deps.config.dataDir, args.projectId);
  return true;
}

export async function listProjectsPendingDeletion(
  deps: Pick<AppDeps, "db">,
): Promise<string[]> {
  return (
    await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(isNotNull(projects.deletedAt))
      .all()
  ).map((project) => project.id);
}
