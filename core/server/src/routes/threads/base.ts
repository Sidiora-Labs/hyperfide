import { countUnarchivedThreadDescendants } from "../../services/threads/thread-archive.js";
import { cancelAbandonedProviderCreations } from "../../services/threads/thread-environment-providers.js";
import {
  THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT,
  THREAD_SEARCH_LIMIT_PER_GROUP_MAX,
  countNonDeletedAssignedChildThreads,
  countThreads,
  getEnvironment,
  getHost,
  getThread,
  getThreadSectionById,
  listThreadMentionRowsByIds,
  listThreadsWithPendingInteractionState,
  markThreadDeleted,
  listThreadDeletionTree,
  listPluginThreadMetadata,
  listThreadAncestors,
  listThreadDescendants,
  searchThreadsWithPendingInteractionState,
  updateThread,
  type ThreadSearchResultGroup as DbThreadSearchResultGroup,
  type UpdateThreadInput,
} from "@hyperfide/db";
import type { Environment, Thread, ThreadListEntry } from "@hyperfide/domain";
import { toEnvironmentResponse } from "../../services/environments/environment-response.js";
import {
  threadIncludeOptionSchema,
  THREAD_COUNT_ROOT_PARENT,
  publicApiRoutes,
  typedRoutes,
  type ThreadGetQuery,
  type ThreadIncludeOption,
  type ThreadChildSummaryResponse,
  type ThreadCountResponse,
  type PluginThreadMetadataListResponse,
  type ThreadAncestorsListResponse,
  type ThreadDescendantsListResponse,
  type ThreadRunningResponse,
  type ThreadSearchResponse,
  type ThreadWithIncludesResponse,
  type PublicApiSchema,
  type ResolveThreadMentionsResponse,
  parseThreadListThreadIds,
} from "@hyperfide/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  parseInteger,
  parsePaginationQuery,
} from "../../services/lib/validation.js";
import {
  getNonDestroyedHostWithStatus,
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
} from "../../services/lib/entity-lookup.js";
import { listRunningThreadsWithIntendedHosts } from "../../services/threads/dispatch-attempt.js";
import { dispatchThreadRenameCommand } from "../../services/threads/thread-commands.js";
import { requestThreadStorageDeletion } from "../../services/threads/thread-lifecycle.js";
import { createThreadFromRequest } from "../../services/threads/thread-create.js";
import { createThreadForkFromRequest } from "../../services/threads/thread-fork.js";
import { requireChildThreadsConfirmation } from "../../services/threads/child-thread-confirmation.js";
import {
  toThreadListEntryResponses,
  toThreadResponseFromThread,
} from "../../services/threads/thread-runtime-display.js";
import { assertValidParentThread } from "../../services/threads/thread-parent.js";
import { handleThreadOwnershipChange } from "../../services/threads/thread-ownership.js";
import { applyThreadExecutionOverride } from "../../services/threads/thread-execution-override.js";
import { applyThreadSessionOptionPatch } from "../../services/threads/thread-session-options.js";
import { emitPluginThreadDeleted } from "../../services/plugins/plugin-thread-events.js";

function parseThreadIncludes(query: ThreadGetQuery): Set<ThreadIncludeOption> {
  const includes = new Set<ThreadIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(threadIncludeOptionSchema.parse(value));
  }
  return includes;
}

interface BuildThreadResponseArgs {
  includes: Set<ThreadIncludeOption>;
  thread: Thread;
}

type ThreadSearchResultGroupResponse = ThreadSearchResponse["active"];

interface BuildThreadSearchGroupResponseArgs {
  group: DbThreadSearchResultGroup;
}

interface BuildThreadSearchResponseArgs {
  active: DbThreadSearchResultGroup;
  archived: DbThreadSearchResultGroup;
}

async function resolveIncludedThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  thread: Thread,
): Promise<Environment | null> {
  if (thread.environmentId === null) {
    return null;
  }
  const environment = await getEnvironment(deps.db, thread.environmentId);
  return environment === null
    ? null
    : await toEnvironmentResponse(deps.db, environment);
}

async function buildThreadResponse(
  deps: AppDeps,
  args: BuildThreadResponseArgs,
): Promise<ThreadWithIncludesResponse> {
  const response: ThreadWithIncludesResponse = await toThreadResponseFromThread(
    deps,
    {
      thread: args.thread,
    },
  );
  const shouldResolveEnvironment =
    args.includes.has("environment") || args.includes.has("host");
  const environment = shouldResolveEnvironment
    ? await resolveIncludedThreadEnvironment(deps, args.thread)
    : null;

  if (args.includes.has("environment")) {
    response.environment = environment;
  }
  if (args.includes.has("host")) {
    response.host = environment
      ? await getNonDestroyedHostWithStatus(deps, environment.hostId)
      : null;
    response.environmentHostName = environment
      ? ((await getHost(deps.db, environment.hostId))?.name ?? null)
      : null;
  }
  return response;
}

function countNonWhitespaceChars(value: string): number {
  return value.replaceAll(/\s/gu, "").length;
}

function threadMentionLabel(thread: {
  id: string;
  title: string | null;
  titleFallback: string | null;
}): string {
  if (thread.title && thread.title.trim().length > 0) {
    return thread.title;
  }
  if (thread.titleFallback && thread.titleFallback.trim().length > 0) {
    return thread.titleFallback;
  }
  return `Thread ${thread.id.slice(0, 8)}`;
}

function parseSearchLimitPerGroup(value: string | undefined): number {
  const limit =
    value === undefined
      ? THREAD_SEARCH_LIMIT_PER_GROUP_DEFAULT
      : parseInteger(value, "limitPerGroup");
  if (limit <= 0) {
    throw new ApiError(
      400,
      "invalid_request",
      "limitPerGroup must be positive",
    );
  }
  if (limit > THREAD_SEARCH_LIMIT_PER_GROUP_MAX) {
    throw new ApiError(
      400,
      "invalid_request",
      `limitPerGroup must be at most ${THREAD_SEARCH_LIMIT_PER_GROUP_MAX}`,
    );
  }
  return limit;
}

async function requireThreadSection(
  deps: Pick<AppDeps, "db">,
  sectionId: string,
): Promise<void> {
  if (!(await getThreadSectionById(deps.db, sectionId))) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }
}

async function buildThreadSearchGroupResponse(
  deps: AppDeps,
  args: BuildThreadSearchGroupResponseArgs,
): Promise<ThreadSearchResultGroupResponse> {
  const threadEntries = await toThreadListEntryResponses(deps, {
    threads: args.group.results.map((result) => result.thread),
  });
  const threadEntriesById = new Map(
    threadEntries.map((thread) => [thread.id, thread]),
  );

  return {
    total: args.group.total,
    results: args.group.results.flatMap((result) => {
      const thread = threadEntriesById.get(result.thread.id);
      if (thread === undefined) {
        return [];
      }
      return [{ thread, matches: result.matches }];
    }),
  };
}

async function buildThreadSearchResponse(
  deps: AppDeps,
  args: BuildThreadSearchResponseArgs,
): Promise<ThreadSearchResponse> {
  return {
    active: await buildThreadSearchGroupResponse(deps, { group: args.active }),
    archived: await buildThreadSearchGroupResponse(deps, {
      group: args.archived,
    }),
  };
}

export function registerThreadBaseRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;

  get(routes.count, async (context, query) => {
    if (query.projectId) {
      await requirePublicProject(deps.db, query.projectId);
    }
    const result = await countThreads(deps.db, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
      ...(query.providerId !== undefined
        ? { providerId: query.providerId }
        : {}),
      ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
      ...(query.parentThreadId === undefined
        ? {}
        : {
            parent:
              query.parentThreadId === THREAD_COUNT_ROOT_PARENT
                ? { kind: "root" as const }
                : {
                    kind: "id" as const,
                    parentThreadId: query.parentThreadId,
                  },
          }),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
      includeArchived: query.includeArchived === "true",
      includeHidden: query.includeHidden === "true",
    });
    const response: ThreadCountResponse = {
      total: result.total,
      ...(result.groups !== undefined ? { groups: result.groups } : {}),
    };
    return context.json(response);
  });

  post(routes.ancestors, async (context, payload) => {
    return context.json({
      threads: await listThreadAncestors(deps.db, payload.threadIds),
    } satisfies ThreadAncestorsListResponse);
  });

  post(routes.descendants, async (context, payload) => {
    return context.json({
      threads: await listThreadDescendants(deps.db, payload.threadIds, {
        includeArchived: payload.includeArchived ?? false,
        includeHidden: payload.includeHidden ?? false,
      }),
    } satisfies ThreadDescendantsListResponse);
  });

  post(routes.pluginMetadata.list, async (context, payload) => {
    const { threads, corruptThreadIds } = await listPluginThreadMetadata(
      deps.db,
      payload.pluginId,
      payload.threadIds,
    );
    for (const threadId of corruptThreadIds) {
      deps.logger.warn(
        `Ignoring corrupt plugin metadata for thread ${threadId}, plugin ${payload.pluginId}`,
      );
    }
    return context.json({ threads } satisfies PluginThreadMetadataListResponse);
  });

  get(routes.running, async (context) => {
    return context.json(
      (await listRunningThreadsWithIntendedHosts(
        deps,
      )) satisfies ThreadRunningResponse,
    );
  });

  get(routes.list, async (context, query) => {
    const { limit, offset } = parsePaginationQuery({
      limit: query.limit,
      offset: query.offset,
    });
    if (query.projectId) {
      await requirePublicProject(deps.db, query.projectId);
    }
    if (query.sectionId && query.unsectioned === "true") {
      throw new ApiError(
        400,
        "invalid_request",
        "sectionId and unsectioned cannot be used together",
      );
    }
    if (query.sectionId) {
      await requireThreadSection(deps, query.sectionId);
    }
    const threads = await listThreadsWithPendingInteractionState(deps.db, {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.environmentId ? { environmentId: query.environmentId } : {}),
      ...(query.hostId ? { hostId: query.hostId } : {}),
      ...(query.parentThreadId ? { parentThreadId: query.parentThreadId } : {}),
      ...(query.sourceThreadId ? { sourceThreadId: query.sourceThreadId } : {}),
      ...(query.sectionId ? { sectionId: query.sectionId } : {}),
      ...(query.unsectioned === "true" ? { unsectioned: true } : {}),
      ...(query.originKind ? { originKind: query.originKind } : {}),
      ...(query.originPluginId ? { originPluginId: query.originPluginId } : {}),
      ...(query.threadIds === undefined
        ? {}
        : { threadIds: parseThreadListThreadIds(query.threadIds) }),
      includeHidden: query.includeHidden === "true",
      archived:
        query.archived === undefined ? undefined : query.archived === "true",
      hasParent:
        query.hasParent === undefined ? undefined : query.hasParent === "true",
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
    return context.json(
      (await toThreadListEntryResponses(deps, {
        threads,
      })) satisfies ThreadListEntry[],
    );
  });

  get(routes.search, async (context, query) => {
    const searchQuery = query.query.trim();
    if (countNonWhitespaceChars(searchQuery) < 2) {
      throw new ApiError(
        400,
        "invalid_request",
        "query must contain at least two non-whitespace characters",
      );
    }
    const limitPerGroup = parseSearchLimitPerGroup(query.limitPerGroup);
    return context.json(
      (await buildThreadSearchResponse(deps, {
        ...(await searchThreadsWithPendingInteractionState(deps.db, {
          query: searchQuery,
          limitPerGroup,
        })),
      })) satisfies ThreadSearchResponse,
    );
  });

  post(routes.resolveMentions, async (context, payload) => {
    const uniqueThreadIds = [...new Set(payload.threadIds)];
    const rowsById = new Map(
      (await listThreadMentionRowsByIds(deps.db, uniqueThreadIds)).map(
        (thread) => [thread.id, thread],
      ),
    );
    const resolved = uniqueThreadIds.flatMap((threadId) => {
      const thread = rowsById.get(threadId);
      if (thread === undefined) {
        return [];
      }
      return [
        {
          threadId: thread.id,
          projectId: thread.projectId,
          label: threadMentionLabel(thread),
        },
      ];
    });
    return context.json(resolved satisfies ResolveThreadMentionsResponse);
  });

  post(routes.create, async (context, payload) => {
    if (payload.sectionId) {
      await requireThreadSection(deps, payload.sectionId);
    }
    const thread = await createThreadFromRequest(deps, {
      ...payload,
      origin: payload.origin,
    });
    return context.json(
      await toThreadResponseFromThread(deps, { thread }),
      201,
    );
  });

  post(routes.fork, async (context, payload) => {
    const thread = await createThreadForkFromRequest(deps, payload);
    return context.json(
      await toThreadResponseFromThread(deps, { thread }),
      201,
    );
  });

  get(routes.get, async (context, query) => {
    const thread = await requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      await buildThreadResponse(deps, {
        includes: parseThreadIncludes(query),
        thread,
      }),
    );
  });

  async function getThreadChildSummary(
    thread: Thread,
  ): Promise<ThreadChildSummaryResponse> {
    const nonDeletedChildCount = await countNonDeletedAssignedChildThreads(
      deps.db,
      {
        parentThreadId: thread.id,
      },
    );
    return {
      nonDeletedChildCount,
      unarchivedDescendantCount: await countUnarchivedThreadDescendants(
        deps.db,
        thread,
      ),
    };
  }

  get(routes.childSummary, async (context) => {
    const thread = await requirePublicThread(deps.db, context.req.param("id"));
    return context.json(await getThreadChildSummary(thread));
  });

  patch(routes.update, async (context, payload) => {
    const thread = await requirePublicThread(deps.db, context.req.param("id"));
    if (payload.parentThreadId) {
      await assertValidParentThread(deps, {
        childThreadId: thread.id,
        parentThreadId: payload.parentThreadId,
      });
    }

    if ("model" in payload || "reasoningLevel" in payload) {
      await applyThreadExecutionOverride(deps, {
        thread,
        patch: {
          ...("model" in payload ? { model: payload.model } : {}),
          ...("reasoningLevel" in payload
            ? { reasoningLevel: payload.reasoningLevel }
            : {}),
        },
      });
    }

    if (payload.sessionOptions !== undefined) {
      await applyThreadSessionOptionPatch(deps, {
        thread,
        patch: payload.sessionOptions,
      });
    }

    const metadataUpdate: UpdateThreadInput = {};
    if ("title" in payload) {
      metadataUpdate.title = payload.title;
    }
    const sectionId = payload.sectionId;
    if (sectionId !== undefined) {
      if (sectionId !== null) {
        await requireThreadSection(deps, sectionId);
      }
      metadataUpdate.sectionId = sectionId;
    } else if (
      payload.parentThreadId === null &&
      thread.parentThreadId !== null
    ) {
      metadataUpdate.sectionId =
        (await getThread(deps.db, thread.parentThreadId))?.sectionId ?? null;
    }
    if ("parentThreadId" in payload) {
      metadataUpdate.parentThreadId = payload.parentThreadId;
    }
    if ("visibility" in payload) {
      metadataUpdate.visibility = payload.visibility;
    }
    if ("parentNotifications" in payload) {
      metadataUpdate.parentNotifications = payload.parentNotifications;
    }
    const updated =
      Object.keys(metadataUpdate).length > 0
        ? await updateThread(deps.db, deps.hub, thread.id, metadataUpdate)
        : await requirePublicThread(deps.db, thread.id);
    if (!updated) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (
      payload.title &&
      payload.title !== thread.title &&
      updated.environmentId
    ) {
      const environment = await requireEnvironment(
        deps.db,
        updated.environmentId,
      );
      if (environment.status === "ready" && environment.path) {
        await dispatchThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          providerId: updated.providerId,
          threadId: updated.id,
          title: payload.title,
        });
      }
    }

    if (
      "parentThreadId" in payload &&
      payload.parentThreadId !== thread.parentThreadId
    ) {
      await handleThreadOwnershipChange(deps, {
        previousThread: thread,
        updatedThread: updated,
      });
    }

    return context.json(
      await toThreadResponseFromThread(deps, { thread: updated }),
    );
  });

  del(routes.delete, async (context, payload) => {
    const thread = await requirePublicThread(deps.db, context.req.param("id"));
    await requireChildThreadsConfirmation({
      action: "delete",
      confirmed: payload.childThreadsConfirmed,
      deps,
      thread,
    });
    const dependents = await listThreadDeletionTree(deps.db, thread.id);
    await markThreadDeleted(deps.db, deps.hub, { threadId: thread.id });
    for (const dependent of dependents) {
      const deleted = await getThread(deps.db, dependent.id);
      if (!deleted) continue;
      if (dependent.deletedAt === null) emitPluginThreadDeleted(deleted);
      await cancelAbandonedProviderCreations(deps, deleted.id);
      await deps.terminalSessions.closeDeletedThreadTerminals({
        threadId: deleted.id,
      });
      await requestThreadStorageDeletion(
        deps,
        deleted,
        deleted.environmentId === null
          ? null
          : await getEnvironment(deps.db, deleted.environmentId),
      );
    }
    return context.json({ ok: true });
  });
}
