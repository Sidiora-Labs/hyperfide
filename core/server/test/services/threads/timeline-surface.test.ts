import { describe, expect, it } from "vitest";
import {
  resolveThreadTimelineSurface,
  type ThreadTimelineSurfaceOptions,
} from "../../../src/services/threads/timeline.js";
import { withTestThread } from "../../helpers/timeline-cache-fixture.js";

const surfaceOptions: ThreadTimelineSurfaceOptions = {
  completedTurnDisplay: "collapse",
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  maxInlineOutputChars: 4_000,
  planCommand: null,
  compactionOfferEnabled: false,
  summarizeShellCommands: true,
};

describe("resolveThreadTimelineSurface", () => {
  it("keys the response cache on the plan command without changing the cursor surface", async () => {
    await withTestThread(async ({ db, thread }) => {
      const withoutPlan = await resolveThreadTimelineSurface(
        db,
        thread,
        surfaceOptions,
      );
      const withPlan = await resolveThreadTimelineSurface(db, thread, {
        ...surfaceOptions,
        planCommand: { trigger: "/", name: "plan", trailingText: " " },
      });
      expect(withPlan.cursorKey).toBe(withoutPlan.cursorKey);
      expect(withPlan.cacheKey).not.toBe(withoutPlan.cacheKey);
    });
  });
});
