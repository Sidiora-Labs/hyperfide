import { setImmediate } from "node:timers/promises";
import { vi } from "vitest";
import { whenChildThreadNotificationsIdle } from "../../src/services/threads/child-thread-notifications.js";
import { withTestHarness, type TestAppHarness } from "./test-app.js";

export async function withChildThreadNotificationClock(
  run: (harness: TestAppHarness) => Promise<void>,
): Promise<void> {
  return await withTestHarness(async (harness) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run(harness);
    } finally {
      vi.useRealTimers();
    }
  });
}

export async function flushChildThreadNotifications(): Promise<void> {
  await setImmediate();
  await vi.advanceTimersByTimeAsync(2_000);
  await whenChildThreadNotificationsIdle();
}
