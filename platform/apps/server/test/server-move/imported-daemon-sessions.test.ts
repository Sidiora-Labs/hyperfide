import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getSessionById, getThread, listEvents } from "@hyperfide/db";
import { threadScope, turnScope } from "@hyperfide/domain";
import {
  writeServerImportFile,
  type ServerImportFile,
} from "@hyperfide/server-archive";
import { describe, expect, it } from "vitest";
import { disconnectImportedDaemonSessions } from "../../src/internal/session-owner-side-effects.js";
import { applyServerImportAtBoot } from "../../src/services/server-move/pending-boot.js";
import {
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const TASK_ITEM_ID = "task:wf-1";
const PROVIDER_THREAD_ID = "claude-session-1";

const MANUAL_IMPORT: ServerImportFile = {
  version: 1,
  kind: "manual",
  moveId: null,
  activationToken: null,
  sourceDataDir: "/home/old/.hyperfide",
  sourceServerHostId: null,
  targetHostId: null,
  serverUrl: null,
  importedEntries: ["bb.db"],
  createdAt: 1,
  fixupsAppliedAt: null,
};

function backgroundTaskData(status: string, taskStatus: string) {
  return {
    providerThreadId: PROVIDER_THREAD_ID,
    item: {
      id: TASK_ITEM_ID,
      type: "backgroundTask",
      taskType: "local_workflow",
      description: "fixture workflow",
      status,
      taskStatus,
      skipTranscript: false,
      foreground: false,
      workflowName: "fixture-mini",
      usage: { totalTokens: 100, toolUses: 2, durationMs: 1500 },
    },
  };
}

async function seedOpenBackgroundTask(
  harness: TestAppHarness,
  args: { environmentId: string; threadId: string },
): Promise<void> {
  await seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    sequence: 1,
    type: "turn/started",
    scope: turnScope("turn-1"),
    providerThreadId: PROVIDER_THREAD_ID,
    data: { providerThreadId: PROVIDER_THREAD_ID },
  });
  await seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    sequence: 2,
    type: "item/started",
    scope: turnScope("turn-1"),
    providerThreadId: PROVIDER_THREAD_ID,
    itemId: TASK_ITEM_ID,
    itemKind: "backgroundTask",
    data: backgroundTaskData("pending", "running"),
  });
  await seedStoredEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    sequence: 3,
    type: "item/backgroundTask/progress",
    scope: threadScope(),
    providerThreadId: PROVIDER_THREAD_ID,
    itemId: TASK_ITEM_ID,
    itemKind: "backgroundTask",
    data: backgroundTaskData("pending", "running"),
  });
}

describe("daemon sessions in an imported server snapshot", () => {
  it("closes them and settles their hosts' work at the first imported boot, and never again", async () => {
    await withTestHarness(async (harness) => {
      const {
        host,
        session,
        project,
        environment,
        thread: activeThread,
      } = await seedThreadFixture(harness, { thread: { status: "active" } });
      await seedTurnStarted(harness.deps, {
        environmentId: environment.id,
        threadId: activeThread.id,
        turnId: "turn-live-1",
      });
      const idleThread = await seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      await seedOpenBackgroundTask(harness, {
        environmentId: environment.id,
        threadId: idleThread.id,
      });
      harness.hub.unregisterDaemon(session.id);
      await writeServerImportFile(harness.config.dataDir, MANUAL_IMPORT);

      const boot = await applyServerImportAtBoot({
        dataDir: harness.config.dataDir,
        db: harness.db,
        logger: testLogger,
        now: 1_000,
      });

      expect(boot.importedDaemonSessions).toEqual([
        { id: session.id, hostId: host.id },
      ]);
      expect(
        (await getSessionById(harness.db, { sessionId: session.id }))?.status,
      ).toBe("active");

      await disconnectImportedDaemonSessions(harness.deps, {
        sessions: boot.importedDaemonSessions,
      });

      expect(
        await getSessionById(harness.db, { sessionId: session.id }),
      ).toMatchObject({ status: "closed", closeReason: "daemon-disconnect" });
      expect(harness.hub.hasDaemonForHost(host.id)).toBe(false);
      expect((await getThread(harness.db, activeThread.id))?.status).toBe(
        "error",
      );
      expect(
        (await listEvents(harness.db, { threadId: activeThread.id }))
          .filter((row) => row.type === "system/thread/interrupted")
          .map((row) => JSON.parse(row.data)),
      ).toEqual([
        { reason: "host-daemon-restarted", cause: "host-connection-lost" },
      ]);
      expect(
        (await listEvents(harness.db, { threadId: idleThread.id }))
          .filter((row) => row.type === "item/backgroundTask/completed")
          .map((row) => JSON.parse(row.data)),
      ).toEqual([
        expect.objectContaining({
          item: expect.objectContaining({
            status: "interrupted",
            taskStatus: "stopped",
          }),
        }),
      ]);

      const nextBoot = await applyServerImportAtBoot({
        dataDir: harness.config.dataDir,
        db: harness.db,
        logger: testLogger,
        now: 2_000,
      });
      expect(nextBoot.importedDaemonSessions).toEqual([]);
    });
  });

  it("closes the imported sessions in runServer after the app exists and before the listener starts", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../../src/start-server.ts", import.meta.url)),
      "utf8",
    );
    const disconnect = source.indexOf("disconnectImportedDaemonSessions(");

    expect(disconnect).toBeGreaterThan(source.indexOf("createApp("));
    expect(disconnect).toBeLessThan(source.indexOf("startHttpListener({"));
    expect(source.slice(disconnect)).toContain(
      "sessions: serverImport.importedDaemonSessions",
    );
  });
});
