export interface DebouncedCallbackSchedulerArgs {
  debounceMs: number;
  maxWaitMs: number;
  onFlush: () => void;
}

export interface DebouncedCallbackScheduler {
  dispose: () => void;
  flush: () => void;
  schedule: () => void;
}

export function createDebouncedCallbackScheduler(
  args: DebouncedCallbackSchedulerArgs,
): DebouncedCallbackScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function flush(): void {
    clearTimers();
    args.onFlush();
  }

  function schedule(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flush, args.debounceMs);
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(flush, args.maxWaitMs);
    }
  }

  return {
    dispose: clearTimers,
    flush,
    schedule,
  };
}
