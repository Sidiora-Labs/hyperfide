import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedCallbackScheduler } from "../src/debounced-callback-scheduler.js";

describe("createDebouncedCallbackScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces repeated schedules into a single flush", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createDebouncedCallbackScheduler({
      debounceMs: 100,
      maxWaitMs: 500,
      onFlush,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.schedule();

    await vi.advanceTimersByTimeAsync(99);
    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes at max wait while schedules keep resetting the debounce timer", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createDebouncedCallbackScheduler({
      debounceMs: 100,
      maxWaitMs: 250,
      onFlush,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(80);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(80);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(80);

    expect(onFlush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately and clears pending timers", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createDebouncedCallbackScheduler({
      debounceMs: 100,
      maxWaitMs: 500,
      onFlush,
    });

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(50);
    scheduler.flush();

    expect(onFlush).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("does not flush after disposal", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createDebouncedCallbackScheduler({
      debounceMs: 100,
      maxWaitMs: 500,
      onFlush,
    });

    scheduler.schedule();
    scheduler.dispose();

    await vi.advanceTimersByTimeAsync(500);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
