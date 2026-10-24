import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { isRawThreadId } from "@hyperfide/domain";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import {
  createThread,
  countLiveThreadsInEnvironment,
  countNonDeletedAssignedChildThreads,
  getThread,
  getThreadExecutionOverride,
  hasActiveThreadAttention,
  setThreadExecutionOverride,
  listHostThreadIds,
  listActiveVisiblePinnedThreadRoots,
  listThreadMentionRowsByIds,
  listThreadEnvironmentAssignmentsOnHost,
  listThreadsWithPendingInteractionStateForProjects,
  listThreadsWithPendingInteractionState,
  updateThread,
  deleteThread,
  archiveThread,
  markThreadDeleted,
  pinThread,
  reorderPinnedThread,
  unpinThread,
  unarchiveThread,
  applyThreadLifecycleEvent,
  requireThreadLifecycleEventApplied,
} from "../../src/data/threads.js";
import { createPendingInteraction } from "../../src/data/pending-interactions.js";
import {
  createThreadSection,
  deleteThreadSection,
  listThreadSections,
  renameThreadSection,
} from "../../src/data/thread-sections.js";
import { createProject, markProjectDeleted } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createEnvironment } from "../../src/data/environments.js";
import { createMigratedConnection } from "../../src/testing.js";

async function setup() {
  const db = await createMigratedConnection();
  const host = await upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = await createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

async function mustCreateThreadSection(
  db: ReturnType<typeof createConnection>,
  name: string,
) {
  const result = await createThreadSection(db, noopNotifier, { name });
  if (result.status !== "created") {
    throw new Error(`Expected section "${name}" to be created`);
  }
  return result.section;
}

describe("threads", () => {
  it("creates pinned threads in order and retains their section after unpinning", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "Managers");
    const first = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pinned: true,
    });
    const second = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
      pinned: true,
    });
    expect(second.pinnedAt).not.toBeNull();
    expect(second.pinSortKey).not.toBeNull();
    expect(second.pinSortKey! < first.pinSortKey!).toBe(true);
    const unpinned = await unpinThread(db, noopNotifier, {
      threadId: second.id,
    });
    expect(unpinned).toMatchObject({
      sectionId: section.id,
      pinnedAt: null,
      pinSortKey: null,
    });
    await db.close();
  });

  it("summarizes favicon attention for active sidebar threads", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      expect(await hasActiveThreadAttention(db)).toBe(false);

      vi.setSystemTime(2_000);
      await db
        .update(threads)
        .set({ latestAttentionAt: Date.now() })
        .where(eq(threads.id, thread.id))
        .run();
      expect(await hasActiveThreadAttention(db)).toBe(true);

      await updateThread(db, noopNotifier, thread.id, { lastReadAt: 2_000 });
      expect(await hasActiveThreadAttention(db)).toBe(false);

      await createPendingInteraction(db, {
        payload: "{}",
        providerId: "codex",
        providerRequestId: "request-1",
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
        turnId: "turn-1",
      });
      expect(await hasActiveThreadAttention(db)).toBe(true);

      await archiveThread(db, noopNotifier, thread.id);
      expect(await hasActiveThreadAttention(db)).toBe(false);

      const sideChat = await createThread(db, noopNotifier, {
        originKind: "fork",
        originPluginId: "side-chat",
        projectId: project.id,
        providerId: "codex",
        sourceThreadId: thread.id,
        visibility: "hidden",
      });
      vi.setSystemTime(3_000);
      await db
        .update(threads)
        .set({ latestAttentionAt: Date.now() })
        .where(eq(threads.id, sideChat.id))
        .run();
      expect(await hasActiveThreadAttention(db)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates and retrieves a thread", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(isRawThreadId(thread.id)).toBe(true);
    expect(thread.status).toBe("starting");
    expect(thread.projectId).toBe(project.id);
    expect(thread.deletedAt).toBeNull();
    expect(thread.lastReadAt).toBe(thread.latestAttentionAt);
    expect(thread.visibility).toBe("visible");

    const fetched = await getThread(db, thread.id);
    expect(fetched?.visibility).toBe("visible");
    expect(fetched).toMatchObject({ id: thread.id });
  });

  it("resolves only exact non-deleted mention thread rows", async () => {
    const { db, project } = await setup();
    const visible = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Visible title",
      titleFallback: "Visible fallback",
    });
    const deleted = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Deleted title",
    });
    await markThreadDeleted(db, noopNotifier, { threadId: deleted.id });

    expect(
      await listThreadMentionRowsByIds(db, [
        visible.id,
        deleted.id,
        "thr_2222222222",
      ]),
    ).toEqual([
      {
        id: visible.id,
        projectId: project.id,
        title: "Visible title",
        titleFallback: "Visible fallback",
      },
    ]);
    expect(await listThreadMentionRowsByIds(db, [])).toEqual([]);

    await markProjectDeleted(db, noopNotifier, { projectId: project.id });
    expect(await listThreadMentionRowsByIds(db, [visible.id])).toEqual([]);
  });

  it("supports an explicit visible-only list with a hidden opt-in", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const visible = await createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
    });
    const hidden = await createThread(db, noopNotifier, {
      parentThreadId: parent.id,
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });

    await pinThread(db, noopNotifier, { threadId: hidden.id });
    await db
      .update(threads)
      .set({ latestAttentionAt: Date.now() })
      .where(eq(threads.id, hidden.id))
      .run();
    await createPendingInteraction(db, {
      payload: "{}",
      providerId: "codex",
      providerRequestId: "hidden-request",
      providerThreadId: "hidden-provider-thread",
      threadId: hidden.id,
      turnId: "hidden-turn",
    });

    expect((await getThread(db, hidden.id))?.visibility).toBe("hidden");
    expect(
      (
        await listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
          includeHidden: false,
        })
      ).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(
      (
        await listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
        })
      ).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(
      (
        await listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
          includeHidden: true,
        })
      )
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([hidden.id, visible.id, parent.id].sort());
    expect(
      (
        await listThreadsWithPendingInteractionStateForProjects(db, {
          projectIds: [project.id],
        })
      ).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(
      (await listActiveVisiblePinnedThreadRoots(db)).map((thread) => thread.id),
    ).not.toContain(hidden.id);
    expect(await hasActiveThreadAttention(db)).toBe(false);
    expect(
      await countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(2);
  });

  it("allows hidden threads to belong to sections", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "Work");
    const createdInSection = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
      visibility: "hidden",
    });
    expect(createdInSection.sectionId).toBe(section.id);

    const movedIntoSection = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      visibility: "hidden",
    });
    await updateThread(db, noopNotifier, movedIntoSection.id, {
      sectionId: section.id,
    });
    expect((await getThread(db, movedIntoSection.id))?.sectionId).toBe(
      section.id,
    );
  });

  it("persists, reads, and clears the thread execution override", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
    });

    expect(await getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: null,
      reasoningLevelOverride: null,
    });

    await setThreadExecutionOverride(db, {
      threadId: thread.id,
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "high",
    });
    expect(await getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "high",
    });

    await setThreadExecutionOverride(db, {
      threadId: thread.id,
      reasoningLevelOverride: "max",
    });
    expect(await getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: "claude-opus-4-8",
      reasoningLevelOverride: "max",
    });

    await setThreadExecutionOverride(db, {
      threadId: thread.id,
      modelOverride: null,
      reasoningLevelOverride: null,
    });
    expect(await getThreadExecutionOverride(db, thread.id)).toEqual({
      modelOverride: null,
      reasoningLevelOverride: null,
    });
  });

  it("pins and unpins threads with durable pin order keys", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const spy: DbNotifier = {
        notifyThread: vi.fn(),
        notifyEnvironment: vi.fn(),
        notifyHost: vi.fn(),
        notifyProject: vi.fn(),
        notifySystem: vi.fn(),
      };
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      const pinned = await pinThread(db, spy, {
        pinnedAt: 2_000,
        threadId: thread.id,
      });

      expect(pinned?.pinnedAt).toBe(2_000);
      expect(pinned?.pinSortKey).not.toBeNull();
      expect(spy.notifyThread).toHaveBeenCalledWith(
        thread.id,
        ["pin-state-changed"],
        { projectId: project.id },
      );

      const pinnedAgain = await pinThread(db, spy, { threadId: thread.id });
      expect(pinnedAgain?.pinSortKey).toBe(pinned?.pinSortKey);
      expect(spy.notifyThread).toHaveBeenCalledTimes(1);

      const unpinned = await unpinThread(db, spy, { threadId: thread.id });
      expect(unpinned?.pinnedAt).toBeNull();
      expect(unpinned?.pinSortKey).toBeNull();
      expect(spy.notifyThread).toHaveBeenCalledTimes(2);

      await unpinThread(db, spy, { threadId: thread.id });
      expect(spy.notifyThread).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orders pinned threads before unpinned siblings", async () => {
    vi.useFakeTimers();
    try {
      const { db, project } = await setup();
      vi.setSystemTime(1_000);
      const first = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(2_000);
      const second = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(3_000);
      const third = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      vi.setSystemTime(4_000);
      const fourth = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });

      await pinThread(db, noopNotifier, { threadId: first.id });
      await pinThread(db, noopNotifier, { threadId: third.id });

      expect(
        (
          await listThreadsWithPendingInteractionState(db, {
            projectId: project.id,
          })
        ).map((thread) => thread.id),
      ).toEqual([third.id, first.id, fourth.id, second.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reorders active visible pinned roots globally", async () => {
    const { db, host, project } = await setup();
    const { project: otherProject } = await createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    const first = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const second = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const third = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const otherProjectThread = await createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
    });
    await pinThread(db, noopNotifier, { threadId: first.id });
    await pinThread(db, noopNotifier, { threadId: second.id });
    await pinThread(db, noopNotifier, { threadId: third.id });
    await pinThread(db, noopNotifier, { threadId: otherProjectThread.id });

    expect(
      (await listActiveVisiblePinnedThreadRoots(db)).map((thread) => thread.id),
    ).toEqual([otherProjectThread.id, third.id, second.id, first.id]);

    const result = await reorderPinnedThread({
      db,
      notifier: noopNotifier,
      threadId: first.id,
      previousThreadId: null,
      nextThreadId: otherProjectThread.id,
    });

    expect(result.kind).toBe("reordered");
    expect(
      (await listActiveVisiblePinnedThreadRoots(db)).map((thread) => thread.id),
    ).toEqual([first.id, otherProjectThread.id, third.id, second.id]);
  });

  it("rejects pinned reorder for unpinned threads, stale neighbors, and hidden child pins", async () => {
    const { db, project } = await setup();
    const pinned = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const unpinned = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const pinnedParent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const pinnedChild = await createThread(db, noopNotifier, {
      parentThreadId: pinnedParent.id,
      projectId: project.id,
      providerId: "codex",
    });
    await pinThread(db, noopNotifier, { threadId: pinned.id });
    await pinThread(db, noopNotifier, { threadId: pinnedParent.id });
    await pinThread(db, noopNotifier, { threadId: pinnedChild.id });

    expect(
      (
        await reorderPinnedThread({
          db,
          notifier: noopNotifier,
          threadId: unpinned.id,
          previousThreadId: null,
          nextThreadId: pinned.id,
        })
      ).kind,
    ).toBe("not_pinned");
    expect(
      (
        await reorderPinnedThread({
          db,
          notifier: noopNotifier,
          threadId: pinned.id,
          previousThreadId: unpinned.id,
          nextThreadId: null,
        })
      ).kind,
    ).toBe("stale_neighbor");
    expect(
      (
        await reorderPinnedThread({
          db,
          notifier: noopNotifier,
          threadId: pinned.id,
          previousThreadId: pinnedChild.id,
          nextThreadId: null,
        })
      ).kind,
    ).toBe("stale_neighbor");
    expect(
      (
        await reorderPinnedThread({
          db,
          notifier: noopNotifier,
          threadId: pinnedChild.id,
          previousThreadId: null,
          nextThreadId: pinned.id,
        })
      ).kind,
    ).toBe("stale_neighbor");
  });

  it("filters archived threads by section id", async () => {
    const { db, project } = await setup();
    const workSection = await mustCreateThreadSection(db, "work");
    const playSection = await mustCreateThreadSection(db, "play");
    const archivedInWork = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    const otherArchivedInWork = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    const archivedInPlay = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: playSection.id,
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: workSection.id,
    });
    await archiveThread(db, noopNotifier, archivedInWork.id);
    await archiveThread(db, noopNotifier, otherArchivedInWork.id);
    await archiveThread(db, noopNotifier, archivedInPlay.id);

    const workArchived = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      archived: true,
      sectionId: workSection.id,
    });
    expect(workArchived.map((thread) => thread.id).sort()).toEqual(
      [archivedInWork.id, otherArchivedInWork.id].sort(),
    );

    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
        archived: true,
        sectionId: playSection.id,
      }),
    ).toHaveLength(1);
  });

  it("filters archived threads to loose (unsectioned) only", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "work");
    const looseArchived = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const sectioned = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    await archiveThread(db, noopNotifier, looseArchived.id);
    await archiveThread(db, noopNotifier, sectioned.id);

    const unsectionedArchived = await listThreadsWithPendingInteractionState(
      db,
      {
        projectId: project.id,
        archived: true,
        unsectioned: true,
      },
    );
    expect(unsectionedArchived.map((thread) => thread.id)).toEqual([
      looseArchived.id,
    ]);
  });

  it("isolates threads by project", async () => {
    const { db, host, project } = await setup();
    const { project: otherProject } = await createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
    });

    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
      }),
    ).toHaveLength(1);
    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: otherProject.id,
      }),
    ).toHaveLength(1);
  });

  it("filters threads by parent thread and archived state", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const child = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await archiveThread(db, noopNotifier, child.id);

    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
        parentThreadId: parent.id,
      }),
    ).toHaveLength(1);
    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
        archived: true,
      }),
    ).toHaveLength(1);
    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
        archived: false,
      }),
    ).toHaveLength(2);
  });

  it("narrows the list to the requested thread IDs, leaving out unknown and deleted ones", async () => {
    const { db, project } = await setup();
    const [kept, archived, deleted, other] = await Promise.all(
      Array.from(
        { length: 4 },
        async () =>
          await createThread(db, noopNotifier, {
            projectId: project.id,
            providerId: "codex",
          }),
      ),
    );
    await archiveThread(db, noopNotifier, archived!.id);
    await markThreadDeleted(db, noopNotifier, { threadId: deleted!.id });
    const threadIds = [kept!.id, archived!.id, deleted!.id, "thr_unknown"];

    expect(
      (await listThreadsWithPendingInteractionState(db, { threadIds }))
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([kept!.id, archived!.id].sort());
    expect(
      (
        await listThreadsWithPendingInteractionState(db, {
          threadIds,
          archived: true,
        })
      ).map((thread) => thread.id),
    ).toEqual([archived!.id]);
    expect(
      await listThreadsWithPendingInteractionState(db, { threadIds: [] }),
    ).toEqual([]);
    expect(
      (await listThreadsWithPendingInteractionState(db, {})).map(
        (thread) => thread.id,
      ),
    ).toContain(other!.id);
  });

  it("filters threads by parent presence", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const child = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const childThreads = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      hasParent: true,
    });
    expect(childThreads).toHaveLength(1);
    expect(childThreads[0]?.id).toBe(child.id);

    const rootThreads = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      hasParent: false,
    });
    expect(rootThreads).toHaveLength(2);
    expect(rootThreads.map((thread) => thread.id)).toContain(parent.id);
  });

  it("paginates archived threads ordered by archive recency", async () => {
    const { db, project } = await setup();
    const created: { id: string }[] = [];
    for (let index = 0; index < 5; index += 1) {
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      created.push(thread);
    }
    for (const thread of created) {
      await archiveThread(db, noopNotifier, thread.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const archivedFirstPage = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      archived: true,
      limit: 3,
    });
    expect(archivedFirstPage.map((thread) => thread.id)).toEqual([
      created[4]?.id,
      created[3]?.id,
      created[2]?.id,
    ]);

    const archivedSecondPage = await listThreadsWithPendingInteractionState(
      db,
      {
        projectId: project.id,
        archived: true,
        limit: 3,
        offset: 3,
      },
    );
    expect(archivedSecondPage.map((thread) => thread.id)).toEqual([
      created[1]?.id,
      created[0]?.id,
    ]);
  });

  it("counts archived assigned child threads", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const archivedChild = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });

    await archiveThread(db, noopNotifier, archivedChild.id);

    expect(
      await countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(1);
  });

  it("excludes deleted assigned child threads", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const deletedChild = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
    });

    await markThreadDeleted(db, noopNotifier, { threadId: deletedChild.id });

    expect(
      await countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(0);
  });

  it("excludes assigned child threads under a different parent", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const otherParent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: otherParent.id,
    });

    expect(
      await countNonDeletedAssignedChildThreads(db, {
        parentThreadId: parent.id,
      }),
    ).toBe(0);
  });

  it("lists each thread's environment identity without per-thread lookups", async () => {
    const { db, host, project } = await setup();
    const directEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      isGitRepo: true,
      branchName: "main",
    });
    const worktreeEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      name: "Review workspace",
      branchName: "hyperfide/worktree",
      environmentProvider: {
        environmentProviderId: "git-worktree",
        instanceKey: null,
        selection: {
          machine: { type: "existing", hostId: host.id },
          inputs: { branch: { kind: "default" } },
        },
      },
    });
    const directThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: directEnvironment.id,
      providerId: "codex",
    });
    const worktreeThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: worktreeEnvironment.id,
      providerId: "codex",
    });

    const environmentIdentityByThreadId = new Map(
      (
        await listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
        })
      ).map((thread) => [
        thread.id,
        {
          environmentBranchName: thread.environmentBranchName,
          environmentProviderId: thread.environmentProviderId,
          environmentHostId: thread.environmentHostId,
          environmentName: thread.environmentName,
        },
      ]),
    );

    expect(environmentIdentityByThreadId.get(directThread.id)).toEqual({
      environmentBranchName: "main",
      environmentProviderId: null,
      environmentHostId: host.id,
      environmentName: null,
    });
    expect(environmentIdentityByThreadId.get(worktreeThread.id)).toEqual({
      environmentBranchName: "hyperfide/worktree",
      environmentProviderId: "git-worktree",
      environmentHostId: host.id,
      environmentName: "Review workspace",
    });
  });

  it("updates thread section id", async () => {
    const { db, project } = await setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const section = await mustCreateThreadSection(db, "Work/Q3");

    const updated = await updateThread(db, spy, thread.id, {
      sectionId: section.id,
    });

    expect(updated?.sectionId).toBe(section.id);
    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["title-changed"],
      { projectId: project.id },
    );
  });

  it("creates explicit thread sections with literal slash names", async () => {
    const { db } = await setup();

    const result = await createThreadSection(db, noopNotifier, {
      name: " Work / Q3 ",
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.section.name).toBe("Work / Q3");
    expect((await listThreadSections(db)).map((entry) => entry.name)).toEqual([
      "Work / Q3",
    ]);
  });

  it("returns duplicate when creating a section with an existing name", async () => {
    const { db } = await setup();
    const existing = await mustCreateThreadSection(db, "Work");

    const result = await createThreadSection(db, noopNotifier, {
      name: "Work",
    });

    expect(result).toEqual({ status: "duplicate", section: existing });
  });

  it("renames a section by id without changing member thread ids", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "Work");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });

    const result = await renameThreadSection(db, noopNotifier, {
      id: section.id,
      name: "Archive",
    });

    expect(result).toEqual({
      status: "renamed",
      result: { id: section.id, name: "Archive", updatedThreadCount: 0 },
    });
    expect((await getThread(db, thread.id))?.sectionId).toBe(section.id);
    expect((await listThreadSections(db)).map((entry) => entry.name)).toEqual([
      "Archive",
    ]);
  });

  it("returns duplicate when renaming a section to an existing name", async () => {
    const { db } = await setup();
    const work = await mustCreateThreadSection(db, "Work");
    const archive = await mustCreateThreadSection(db, "Archive");

    const result = await renameThreadSection(db, noopNotifier, {
      id: work.id,
      name: "Archive",
    });

    expect(result).toEqual({ status: "duplicate", section: archive });
    expect((await listThreadSections(db)).map((entry) => entry.name)).toEqual([
      "Archive",
      "Work",
    ]);
  });

  it("returns not_found when renaming a missing section id", async () => {
    const { db } = await setup();
    const result = await renameThreadSection(db, noopNotifier, {
      id: "sec_missing",
      name: "Archive",
    });

    expect(result).toEqual({ status: "not_found" });
  });

  it("removes a section and clears direct member thread section ids", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "Work");
    const siblingSection = await mustCreateThreadSection(db, "Work / Q3");
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const siblingThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: siblingSection.id,
    });

    const result = await deleteThreadSection(db, noopNotifier, {
      id: section.id,
    });

    expect(result).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 1,
    });
    expect((await getThread(db, thread.id))?.sectionId).toBeNull();
    expect((await getThread(db, siblingThread.id))?.sectionId).toBe(
      siblingSection.id,
    );
    expect((await listThreadSections(db)).map((entry) => entry.name)).toEqual([
      "Work / Q3",
    ]);
  });

  it("includes hidden members in section lists and deletion counts", async () => {
    const { db, project } = await setup();
    const section = await mustCreateThreadSection(db, "Work");
    const visible = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const hidden = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
      visibility: "hidden",
    });

    expect(
      (
        await listThreadsWithPendingInteractionState(db, {
          projectId: project.id,
          sectionId: section.id,
          includeHidden: true,
        })
      )
        .map((thread) => thread.id)
        .sort(),
    ).toEqual([visible.id, hidden.id].sort());

    expect(
      await deleteThreadSection(db, noopNotifier, { id: section.id }),
    ).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 2,
    });
    expect((await getThread(db, visible.id))?.sectionId).toBeNull();
    expect((await getThread(db, hidden.id))?.sectionId).toBeNull();
  });

  it("removes a section for threads across every project", async () => {
    const { db, host, project } = await setup();
    const { project: otherProject } = await createProject(db, noopNotifier, {
      name: "other-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/other" },
    });
    const section = await mustCreateThreadSection(db, "Work");
    const projectThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      sectionId: section.id,
    });
    const otherProjectThread = await createThread(db, noopNotifier, {
      projectId: otherProject.id,
      providerId: "codex",
      sectionId: section.id,
    });

    const result = await deleteThreadSection(db, noopNotifier, {
      id: section.id,
    });

    expect(result).toEqual({
      id: section.id,
      name: "Work",
      updatedThreadCount: 2,
    });
    expect((await getThread(db, projectThread.id))?.sectionId).toBeNull();
    expect((await getThread(db, otherProjectThread.id))?.sectionId).toBeNull();
    expect(await listThreadSections(db)).toEqual([]);
  });

  it("notifies when a thread parent changes", async () => {
    const { db, project } = await setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const parentThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const childThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    await updateThread(db, spy, childThread.id, {
      parentThreadId: parentThread.id,
    });

    expect(spy.notifyThread).toHaveBeenCalledWith(
      childThread.id,
      ["parent-changed"],
      { projectId: project.id },
    );
  });

  it("notifies when a thread environment changes", async () => {
    const { db, host, project } = await setup();
    const spy: DbNotifier = {
      notifyThread: vi.fn(),
      notifyEnvironment: vi.fn(),
      notifyHost: vi.fn(),
      notifyProject: vi.fn(),
      notifySystem: vi.fn(),
    };
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/test-workspace",
      status: "ready",
    });
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    await updateThread(db, spy, thread.id, {
      environmentId: environment.id,
    });

    expect(spy.notifyThread).toHaveBeenCalledWith(
      thread.id,
      ["environment-changed"],
      { projectId: project.id },
    );
  });

  it("preserves read state when renaming a read thread", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      await updateThread(db, noopNotifier, thread.id, {
        lastReadAt: thread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const updated = await updateThread(db, noopNotifier, thread.id, {
        title: "New title",
      });

      expect(updated?.title).toBe("New title");
      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.lastReadAt).toBe(1_000);
      expect(updated?.latestAttentionAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unread threads unread when renaming", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const thread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      await updateThread(db, noopNotifier, thread.id, {
        lastReadAt: null,
      });

      vi.setSystemTime(2_000);
      const updated = await updateThread(db, noopNotifier, thread.id, {
        title: "New title",
      });

      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.lastReadAt).toBeNull();
      expect(updated?.latestAttentionAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a thread", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    expect(await deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(await getThread(db, thread.id)).toBeNull();
    expect(await deleteThread(db, noopNotifier, thread.id)).toBe(false);
  });

  it("marks a thread deleted and hides it from public list queries", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    const deleted = await markThreadDeleted(db, noopNotifier, {
      threadId: thread.id,
    });

    expect(deleted?.deletedAt).toBeTypeOf("number");
    expect((await getThread(db, thread.id))?.deletedAt).toBeTypeOf("number");
    expect(
      await listThreadsWithPendingInteractionState(db, {
        projectId: project.id,
      }),
    ).toHaveLength(0);
  });

  it("unarchives a thread", async () => {
    const { db, project } = await setup();
    const thread = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    await archiveThread(db, noopNotifier, thread.id);

    const unarchived = await unarchiveThread(db, noopNotifier, thread.id);
    expect(unarchived?.archivedAt).toBeNull();
    expect(unarchived?.latestAttentionAt).toBe(thread.latestAttentionAt);
  });

  it("counts only non-archived, non-deleted threads as live", async () => {
    const { db, project, host } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-live-count",
      status: "ready",
    });
    const liveThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });
    const archivedThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });
    const deletedThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
      status: "idle",
    });

    await archiveThread(db, noopNotifier, archivedThread.id);
    await markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      await countLiveThreadsInEnvironment(db, {
        environmentId: environment.id,
      }),
    ).toBe(1);
    expect(
      await countLiveThreadsInEnvironment(db, {
        environmentId: environment.id,
        excludeThreadId: liveThread.id,
      }),
    ).toBe(0);
  });

  it("lists canonical thread environments for a host", async () => {
    const { db, project, host } = await setup();
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "other-host",
    });
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-host-match",
      status: "ready",
    });
    const otherEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: otherHost.id,
      path: "/tmp/thread-host-other",
      status: "ready",
    });
    const matchingThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const otherThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: otherEnvironment.id,
      providerId: "codex",
    });

    expect(
      await listThreadEnvironmentAssignmentsOnHost(db, {
        hostId: host.id,
        threadIds: [matchingThread.id, otherThread.id],
      }),
    ).toEqual([
      {
        threadId: matchingThread.id,
        environmentId: environment.id,
      },
    ]);
  });

  it("lists host thread ids only for environments on that host", async () => {
    const { db, project, host } = await setup();
    const otherHost = await upsertHost(db, noopNotifier, {
      name: "other-host",
    });
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-host-match",
      status: "ready",
    });
    const otherEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: otherHost.id,
      path: "/tmp/thread-host-other",
      status: "ready",
    });
    const activeThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const stoppingThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: otherEnvironment.id,
      providerId: "codex",
    });
    requireThreadLifecycleEventApplied(
      await applyThreadLifecycleEvent(db, {
        event: { type: "stop.requested" },
        threadId: stoppingThread.id,
      }),
    );
    expect((await getThread(db, stoppingThread.id))?.status).toBe("stopping");

    expect(await listHostThreadIds(db, { hostId: host.id })).toEqual([
      activeThread.id,
      stoppingThread.id,
    ]);
  });

  it("lists every host thread id including archived, deleted, and destroyed-environment threads", async () => {
    const { db, project, host } = await setup();
    const environment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/thread-storage-targets",
      status: "ready",
    });
    const destroyedEnvironment = await createEnvironment(db, noopNotifier, {
      providerOwnsPath: false,
      projectId: project.id,
      hostId: host.id,
      path: "/tmp/destroyed-thread-storage-targets",
      status: "destroyed",
    });
    const activeThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const destroyedEnvironmentThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: destroyedEnvironment.id,
      providerId: "codex",
    });
    const archivedThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    const deletedThread = await createThread(db, noopNotifier, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    await archiveThread(db, noopNotifier, archivedThread.id);
    await markThreadDeleted(db, noopNotifier, { threadId: deletedThread.id });

    expect(
      [...(await listHostThreadIds(db, { hostId: host.id }))].sort(),
    ).toEqual(
      [
        activeThread.id,
        archivedThread.id,
        deletedThread.id,
        destroyedEnvironmentThread.id,
      ].sort(),
    );
  });
});

describe("thread lifecycle transitions and read state", () => {
  it("only attention-worthy status transitions make a read thread unread", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const activeThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });
      await updateThread(db, noopNotifier, activeThread.id, {
        lastReadAt: activeThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const idleThread = requireThreadLifecycleEventApplied(
        await applyThreadLifecycleEvent(db, {
          event: { type: "run.succeeded" },
          threadId: activeThread.id,
        }),
      );
      expect(idleThread.status).toBe("idle");
      expect(idleThread.updatedAt).toBe(2_000);
      expect(idleThread.latestAttentionAt).toBe(2_000);
      expect(idleThread.lastReadAt).toBe(1_000);

      await updateThread(db, noopNotifier, activeThread.id, {
        lastReadAt: idleThread.latestAttentionAt,
      });
      vi.setSystemTime(3_000);
      const activeAgainThread = requireThreadLifecycleEventApplied(
        await applyThreadLifecycleEvent(db, {
          event: { type: "run.started" },
          threadId: activeThread.id,
        }),
      );
      expect(activeAgainThread.status).toBe("active");
      expect(activeAgainThread.updatedAt).toBe(3_000);
      expect(activeAgainThread.latestAttentionAt).toBe(2_000);
      expect(activeAgainThread.lastReadAt).toBe(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves read state for non-attention error transitions", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { db, project } = await setup();
      const stoppingThread = await createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "stopping",
      });
      await updateThread(db, noopNotifier, stoppingThread.id, {
        lastReadAt: stoppingThread.latestAttentionAt,
      });

      vi.setSystemTime(2_000);
      const erroredThread = requireThreadLifecycleEventApplied(
        await applyThreadLifecycleEvent(db, {
          event: { type: "run.failed" },
          threadId: stoppingThread.id,
        }),
      );
      expect(erroredThread.status).toBe("error");
      expect(erroredThread.updatedAt).toBe(2_000);
      expect(erroredThread.latestAttentionAt).toBe(1_000);
      expect(erroredThread.lastReadAt).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("thread originKind", () => {
  it("persists and filters by originKind", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const fork = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
    });
    expect(await getThread(db, fork.id)).toMatchObject({
      originKind: "fork",
    });
    const forks = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      originKind: "fork",
    });
    expect(forks.map((thread) => thread.id)).toEqual([fork.id]);

    const all = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
    });
    expect(all.map((thread) => thread.id).sort()).toEqual(
      [parent.id, fork.id].sort(),
    );
  });

  it("filters listings by originPluginId", async () => {
    const { db, project } = await setup();
    const parent = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const ownFork = await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
      originPluginId: "side-chat",
    });
    await createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      parentThreadId: parent.id,
      originKind: "fork",
      originPluginId: "some-other-plugin",
    });

    const own = await listThreadsWithPendingInteractionState(db, {
      projectId: project.id,
      originKind: "fork",
      originPluginId: "side-chat",
    });

    expect(own.map((thread) => thread.id)).toEqual([ownFork.id]);
  });
});
