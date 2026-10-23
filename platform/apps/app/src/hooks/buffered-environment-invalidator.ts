import {
  createDebouncedCallbackScheduler,
  type EnvironmentChangeKind,
} from "@bb/domain";

interface BufferedEnvironmentInvalidatorOptions {
  debounceMs: number;
  flushChangedEnvironmentIds: (
    changedEnvironments: Array<{
      changeKinds: EnvironmentChangeKind[];
      environmentId: string;
    }>,
  ) => void;
  maxWaitMs: number;
}

interface BufferedEnvironmentInvalidator {
  dispose: () => void;
  markChanged: (
    environmentId: string,
    changeKinds: readonly EnvironmentChangeKind[],
  ) => void;
}

export function createBufferedEnvironmentInvalidator(
  options: BufferedEnvironmentInvalidatorOptions,
): BufferedEnvironmentInvalidator {
  const changedEnvironmentKindsById = new Map<
    string,
    Set<EnvironmentChangeKind>
  >();

  const flush = () => {
    if (changedEnvironmentKindsById.size === 0) {
      return;
    }
    options.flushChangedEnvironmentIds(
      Array.from(changedEnvironmentKindsById.entries()).map(
        ([environmentId, changeKinds]) => ({
          changeKinds: Array.from(changeKinds),
          environmentId,
        }),
      ),
    );
    changedEnvironmentKindsById.clear();
  };

  const scheduler = createDebouncedCallbackScheduler({
    debounceMs: options.debounceMs,
    maxWaitMs: options.maxWaitMs,
    onFlush: flush,
  });

  return {
    dispose: () => {
      scheduler.dispose();
      changedEnvironmentKindsById.clear();
    },
    markChanged: (
      environmentId: string,
      changeKinds: readonly EnvironmentChangeKind[],
    ) => {
      let entry = changedEnvironmentKindsById.get(environmentId);
      if (!entry) {
        entry = new Set<EnvironmentChangeKind>();
        changedEnvironmentKindsById.set(environmentId, entry);
      }
      for (const changeKind of changeKinds) {
        entry.add(changeKind);
      }
      scheduler.schedule();
    },
  };
}
