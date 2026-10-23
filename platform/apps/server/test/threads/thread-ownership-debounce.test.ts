import { archiveThread, getThread, updateThread } from "@hyperfide/db";
import type { ThreadParentNotifications } from "@hyperfide/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { handleThreadOwnershipChange, whenOwnershipNoticesIdle } from "../../src/services/threads/thread-ownership.js";

async function advanceOwnershipClock(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await whenOwnershipNoticesIdle();
}
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

vi.mock(
  "../../src/services/threads/parent-system-messages.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/services/threads/parent-system-messages.js")
    >()),
    queueParentSystemMessage: vi.fn().mockResolvedValue(true),
  }),
);

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function withOwnershipFixture(
  run: (fixture: {
    childId: string;
    secondChildId: string;
    parents: string[];
    move: (childId: string, parentId: string | null) => Promise<void>;
    setParentNotifications: (
      value: ThreadParentNotifications,
    ) => void | Promise<void>;
    archive: () => void | Promise<void>;
  }) => Promise<void>,
) {
  await withTestHarness(async (harness) => {
    const { host } = await seedHostSession(harness.deps);
    const { project } = await seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const parents = await Promise.all(
      ["A", "B", "C"].map(
        async (title) =>
          (
            await seedThread(harness.deps, {
              projectId: project.id,
              title,
            })
          ).id,
      ),
    );
    const child = await seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId: parents[0],
    });
    const secondChild = await seedThread(harness.deps, {
      projectId: project.id,
      parentThreadId: parents[0],
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run({
        childId: child.id,
        secondChildId: secondChild.id,
        parents,
        async move(childId, parentThreadId) {
          const previousThread = (await getThread(harness.db, childId))!;
          const updatedThread = (await updateThread(
            harness.db,
            harness.deps.hub,
            childId,
            { parentThreadId },
          ))!;
          await handleThreadOwnershipChange(harness.deps, {
            previousThread,
            updatedThread,
          });
          expect((await getThread(harness.db, childId))?.parentThreadId).toBe(
            parentThreadId,
          );
        },
        async setParentNotifications(parentNotifications) {
          await updateThread(harness.db, harness.deps.hub, child.id, {
            parentNotifications,
          });
        },
        async archive() {
          await archiveThread(harness.db, harness.deps.hub, child.id);
        },
      });
    } finally {
      await advanceOwnershipClock(2_000);
      vi.useRealTimers();
    }
  });
}

function notices() {
  return vi.mocked(queueParentSystemMessage).mock.calls.map(([, args]) => ({
    parent: args.parentThreadId,
    kind: args.systemMessageKind,
  }));
}

describe("ownership notice debounce", () => {
  it("waits two seconds before notifying the original and final parents", async () => {
    await withOwnershipFixture(async ({ childId, parents: [a, b], move }) => {
      await move(childId, b);
      await advanceOwnershipClock(1_999);
      expect(notices()).toEqual([]);
      await advanceOwnershipClock(1);
      expect(notices()).toEqual([
        { parent: b, kind: "ownership-assigned" },
        { parent: a, kind: "ownership-removed" },
      ]);
    });
  });

  it("suppresses a move corrected at 1,999 ms", async () => {
    await withOwnershipFixture(async ({ childId, parents: [a, b], move }) => {
      await move(childId, b);
      await advanceOwnershipClock(1_999);
      await move(childId, a);
      await advanceOwnershipClock(2_000);
      expect(notices()).toEqual([]);
    });
  });

  it("resets the deadline and never notifies an intermediate parent", async () => {
    await withOwnershipFixture(
      async ({ childId, parents: [a, b, c], move }) => {
        await move(childId, b);
        await advanceOwnershipClock(1_000);
        await move(childId, c);
        await advanceOwnershipClock(1_999);
        expect(notices()).toEqual([]);
        await advanceOwnershipClock(1);
        expect(notices()).toEqual([
          { parent: c, kind: "ownership-assigned" },
          { parent: a, kind: "ownership-removed" },
        ]);
      },
    );
  });

  it("preserves an originally absent parent across multiple moves", async () => {
    await withOwnershipFixture(async ({ childId, parents: [a, b], move }) => {
      await move(childId, null);
      await advanceOwnershipClock(2_000);
      vi.mocked(queueParentSystemMessage).mockClear();
      await move(childId, a);
      await move(childId, b);
      await advanceOwnershipClock(2_000);
      expect(notices()).toEqual([{ parent: b, kind: "ownership-assigned" }]);
    });
  });

  it("debounces children independently", async () => {
    await withOwnershipFixture(
      async ({ childId, secondChildId, parents: [a, b, c], move }) => {
        await move(childId, b);
        await advanceOwnershipClock(1_000);
        await move(secondChildId, c);
        await move(childId, a);
        await advanceOwnershipClock(2_000);
        expect(notices()).toEqual([
          { parent: c, kind: "ownership-assigned" },
          { parent: a, kind: "ownership-removed" },
        ]);
      },
    );
  });

  it("uses the delivered parent as the baseline for a later correction", async () => {
    await withOwnershipFixture(async ({ childId, parents: [a, b], move }) => {
      await move(childId, b);
      await advanceOwnershipClock(2_000);
      expect(notices()).toHaveLength(2);
      vi.mocked(queueParentSystemMessage).mockClear();
      await move(childId, a);
      await advanceOwnershipClock(1_999);
      expect(notices()).toEqual([]);
      await advanceOwnershipClock(1);
      expect(notices()).toEqual([
        { parent: a, kind: "ownership-assigned" },
        { parent: b, kind: "ownership-removed" },
      ]);
    });
  });

  it("skips notices if the child is archived before delivery", async () => {
    await withOwnershipFixture(
      async ({ childId, parents: [, b], move, archive }) => {
        await move(childId, b);
        await archive();
        await advanceOwnershipClock(2_000);
        expect(notices()).toEqual([]);
      },
    );
  });

  it.each(["stuck", "off"] as const)(
    "skips the unassignment notice when parent notifications are %s",
    async (value) => {
      await withOwnershipFixture(
        async ({ childId, parents: [a, b], move, setParentNotifications }) => {
          await setParentNotifications(value);
          await move(childId, null);
          await advanceOwnershipClock(2_000);
          expect(notices()).toEqual([]);
          await move(childId, a);
          await advanceOwnershipClock(2_000);
          vi.mocked(queueParentSystemMessage).mockClear();
          await move(childId, b);
          await advanceOwnershipClock(2_000);
          expect(notices()).toEqual([
            { parent: b, kind: "ownership-assigned" },
          ]);
        },
      );
    },
  );
});
