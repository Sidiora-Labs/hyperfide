import { getThread, markThreadDeleted, pinThread } from "@bb/db";
import { threadSchema } from "@bb/domain";
import { apiErrorSchema, threadListResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public thread pinning", () => {
  it("pins and unpins threads idempotently", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-pinning-idempotent",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-pinning-idempotent-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const pinResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/pin`,
        { method: "POST" },
      );
      expect(pinResponse.status).toBe(200);
      const pinnedThread = threadSchema.parse(await readJson(pinResponse));
      expect(pinnedThread.id).toBe(thread.id);
      expect(pinnedThread.pinnedAt).toEqual(expect.any(Number));
      const pinnedRow = getThread(harness.db, thread.id);
      if (!pinnedRow) {
        throw new Error("Expected pinned thread row");
      }
      expect(pinnedRow.pinSortKey).toEqual(expect.any(String));
      const initialPinSortKey = pinnedRow.pinSortKey;

      const repeatedPinResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/pin`,
        { method: "POST" },
      );
      expect(repeatedPinResponse.status).toBe(200);
      const repeatedPinnedThread = threadSchema.parse(
        await readJson(repeatedPinResponse),
      );
      expect(repeatedPinnedThread.pinnedAt).toBe(pinnedThread.pinnedAt);
      const repeatedPinnedRow = getThread(harness.db, thread.id);
      if (!repeatedPinnedRow) {
        throw new Error("Expected repeatedly pinned thread row");
      }
      expect(repeatedPinnedRow.pinSortKey).toBe(initialPinSortKey);

      const unpinResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unpin`,
        { method: "POST" },
      );
      expect(unpinResponse.status).toBe(200);
      const unpinnedThread = threadSchema.parse(await readJson(unpinResponse));
      expect(unpinnedThread.pinnedAt).toBeNull();
      const unpinnedRow = getThread(harness.db, thread.id);
      if (!unpinnedRow) {
        throw new Error("Expected unpinned thread row");
      }
      expect(unpinnedRow.pinSortKey).toBeNull();

      const repeatedUnpinResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unpin`,
        { method: "POST" },
      );
      expect(repeatedUnpinResponse.status).toBe(200);
      const repeatedUnpinnedThread = threadSchema.parse(
        await readJson(repeatedUnpinResponse),
      );
      expect(repeatedUnpinnedThread.pinnedAt).toBeNull();
    });
  });

  it("rejects missing and deleted threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-pinning-not-found",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-pinning-not-found-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const missingResponse = await harness.app.request(
        "/api/v1/threads/thr_missing/pin",
        { method: "POST" },
      );
      expect(missingResponse.status).toBe(404);
      expect(
        apiErrorSchema.parse(await readJson(missingResponse)),
      ).toMatchObject({
        code: "thread_not_found",
      });

      expect(
        markThreadDeleted(harness.db, harness.hub, {
          threadId: thread.id,
        }),
      ).not.toBeNull();
      const deletedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unpin`,
        { method: "POST" },
      );
      expect(deletedResponse.status).toBe(404);
      expect(
        apiErrorSchema.parse(await readJson(deletedResponse)),
      ).toMatchObject({
        code: "thread_not_found",
      });
    });
  });

  it("reorders pinned threads and returns visible pinned roots", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-pinning-reorder",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-pinning-reorder-source",
      });
      const firstThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "First pinned thread",
      });
      const secondThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Second pinned thread",
      });
      const thirdThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Third pinned thread",
      });
      expect(
        pinThread(harness.db, harness.hub, { threadId: firstThread.id }),
      ).not.toBeNull();
      expect(
        pinThread(harness.db, harness.hub, { threadId: secondThread.id }),
      ).not.toBeNull();
      expect(
        pinThread(harness.db, harness.hub, { threadId: thirdThread.id }),
      ).not.toBeNull();

      const response = await harness.app.request(
        `/api/v1/threads/${firstThread.id}/pin-order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousThreadId: null,
            nextThreadId: thirdThread.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      const threads = threadListResponseSchema.parse(await readJson(response));
      expect(threads.map((listedThread) => listedThread.id)).toEqual([
        firstThread.id,
        thirdThread.id,
        secondThread.id,
      ]);
      expect(threads.map((listedThread) => listedThread.pinnedAt)).toEqual([
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      ]);
    });
  });

  it("maps pinned reorder conflicts", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-pinning-reorder-conflicts",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-pinning-reorder-conflicts-source",
      });
      const pinnedThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const unpinnedThread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const notPinnedResponse = await harness.app.request(
        `/api/v1/threads/${unpinnedThread.id}/pin-order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousThreadId: null,
            nextThreadId: null,
          }),
        },
      );
      expect(notPinnedResponse.status).toBe(409);
      expect(
        apiErrorSchema.parse(await readJson(notPinnedResponse)),
      ).toMatchObject({
        code: "invalid_request",
        message: "Thread is not pinned",
      });

      expect(
        pinThread(harness.db, harness.hub, { threadId: pinnedThread.id }),
      ).not.toBeNull();
      const staleNeighborResponse = await harness.app.request(
        `/api/v1/threads/${pinnedThread.id}/pin-order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousThreadId: null,
            nextThreadId: unpinnedThread.id,
          }),
        },
      );
      expect(staleNeighborResponse.status).toBe(409);
      expect(
        apiErrorSchema.parse(await readJson(staleNeighborResponse)),
      ).toMatchObject({
        code: "invalid_request",
        message: "Pinned thread order changed",
      });
    });
  });
});
