import { describe, expect, it } from "vitest";
import { setAppSettings } from "@hyperfide/db";
import { defaultAppSettings, turnScope } from "@hyperfide/domain";
import {
  threadTimelineResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
  type TimelineRow,
} from "@hyperfide/server-contract";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const COMMAND = "grep -qv pending checks.log";
const SUMMARY = [
  { type: "search", command: COMMAND, query: "pending", path: "checks.log" },
];

async function seedTurnWithCommand(
  harness: TestAppHarness,
  completed: boolean,
): Promise<{ threadId: string; turnId: string }> {
  const { environment, thread } = await seedThreadFixture(harness);
  const turnId = "turn-1";
  const turn = {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "p1",
    scope: turnScope(turnId),
  } as const;
  const item = {
    type: "commandExecution",
    id: "poll",
    command: COMMAND,
    cwd: "/tmp",
    approvalStatus: null,
  } as const;
  await seedEvent(harness.deps, {
    ...turn,
    sequence: 1,
    type: "turn/started",
    data: {},
  });
  await seedEvent(harness.deps, {
    ...turn,
    sequence: 2,
    type: "item/started",
    data: { item: { ...item, status: "pending" } },
  });
  await seedEvent(harness.deps, {
    ...turn,
    sequence: 3,
    type: "item/completed",
    data: {
      item: {
        ...item,
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "All checks were successful\n",
      },
    },
  });
  if (completed) {
    await seedEvent(harness.deps, {
      ...turn,
      sequence: 4,
      type: "turn/completed",
      data: { status: "completed" },
    });
  }
  return { threadId: thread.id, turnId };
}

function commandIntents(rows: readonly TimelineRow[]): unknown[] {
  return rows.flatMap((row) =>
    row.kind === "work" && row.workKind === "command"
      ? [row.activityIntents]
      : [],
  );
}

describe("shell command summaries", () => {
  it("follows the setting, including cached timeline responses", async () => {
    await withTestHarness(async (harness) => {
      const { threadId } = await seedTurnWithCommand(harness, false);
      const readIntents = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${threadId}/timeline`,
        );
        expect(response.status).toBe(200);
        return commandIntents(
          threadTimelineResponseSchema.parse(await readJson(response)).rows,
        );
      };

      expect(await readIntents()).toEqual([SUMMARY]);
      await setAppSettings(harness.db, {
        ...defaultAppSettings,
        summarizeShellCommands: false,
      });
      expect(await readIntents()).toEqual([[]]);
      await setAppSettings(harness.db, defaultAppSettings);
      expect(await readIntents()).toEqual([SUMMARY]);
    });
  });

  it("follows the setting in completed turn details", async () => {
    await withTestHarness(async (harness) => {
      const { threadId, turnId } = await seedTurnWithCommand(harness, true);
      const readIntents = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${threadId}/timeline/turn-summary-details?turnId=${turnId}&sourceSeqStart=1&sourceSeqEnd=4`,
        );
        expect(response.status).toBe(200);
        return commandIntents(
          timelineTurnSummaryDetailsResponseSchema.parse(
            await readJson(response),
          ).rows,
        );
      };

      expect(await readIntents()).toEqual([SUMMARY]);
      await setAppSettings(harness.db, {
        ...defaultAppSettings,
        summarizeShellCommands: false,
      });
      expect(await readIntents()).toEqual([[]]);
    });
  });
});
