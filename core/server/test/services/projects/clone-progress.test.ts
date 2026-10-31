import { afterEach, expect, it, vi } from "vitest";
import { createCloneProgressReporter } from "../../../src/services/projects/clone-progress.js";

afterEach(() => vi.useRealTimers());

it("coalesces bursts, skips duplicates, and flushes the final update on disposal", async () => {
  vi.useFakeTimers();
  const log = vi.fn();
  const progress = await createCloneProgressReporter({ log, step: log });
  try {
    await progress.report.log("start");
    for (let i = 0; i < 1000; i++)
      await progress.report.log(`Receiving objects: ${i}`);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith("Receiving objects: 999");
    await progress.report.log("Receiving objects: 999");
    await progress.dispose();
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    await progress.dispose();
  }
  const final = await createCloneProgressReporter({ log, step: log });
  await final.report.log("start");
  await final.report.log("done");
  await final.dispose();
  expect(log).toHaveBeenLastCalledWith("done");
  await final.report.log("late");
  expect(log).toHaveBeenLastCalledWith("done");
  expect(vi.getTimerCount()).toBe(0);
});
