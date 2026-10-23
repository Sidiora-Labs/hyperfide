/** Projection of the unmerged 3.1 bridge and 2.3 task/thread binding. */
export interface TaskThread {
  id: string;
  repository: string;
  task: string;
}

export interface AskRow {
  id: string | number;
  task: string;
  session?: string | null;
  kind: string;
  question: string;
  status: string;
  recommendation?: string | null;
  answer?: string | null;
  secret_ref?: string | null;
  blocking?: boolean;
  default_policy?: string;
}

export interface AskPolicy {
  default_policy: "block" | "proceed-and-flag";
}

export interface AskBridge {
  policy(repository: string): Promise<Record<string, AskPolicy>>;
  list(repository: string): Promise<readonly AskRow[]>;
  watch(repository: string, changed: () => void): () => void;
}

export interface TaskThreads {
  list(repository: string): Promise<readonly TaskThread[]>;
}

/** Normalize the binary's row names at the temporary bridge boundary. */
export function createProjectedAskBridge(rpc: {
  policy(repository: string): Promise<Record<string, AskPolicy>>;
  list(repository: string): Promise<
    readonly (Omit<AskRow, "question" | "status"> & {
      title: string;
      state: string;
      recommended?: string | null;
    })[]
  >;
  watch(repository: string, changed: () => void): () => void;
}): AskBridge {
  return {
    policy: (repository) => rpc.policy(repository),
    async list(repository) {
      return (await rpc.list(repository)).map((row) => ({
        ...row,
        question: row.title,
        status: row.state,
        recommendation: row.recommended,
      }));
    },
    watch: (repository, changed) => rpc.watch(repository, changed),
  };
}

/** Adapt the store bridge's policy table and asynchronous host watcher. */
export function createStoreThreadBridge(
  bridge: import("./bridge.js").AskBridge,
  onError: (error: unknown) => void,
): AskBridge {
  return {
    async policy(repository) {
      return Object.fromEntries(
        Object.entries(await bridge.policy(repository)).map(
          ([kind, default_policy]) => [kind, { default_policy }],
        ),
      );
    },
    async list(repository) {
      return (await bridge.list(repository)).map((row) => ({
        ...row,
        task: row.task ?? "",
        session: typeof row.session === "string" ? row.session : null,
        answer: typeof row.answer === "string" ? row.answer : null,
        recommendation: row.recommendation,
      }));
    },
    watch(repository, changed) {
      let disposed = false;
      let stop: (() => void) | undefined;
      void bridge
        .watch(repository, changed)
        .then((unwatch) => {
          if (disposed) unwatch();
          else stop = unwatch;
        })
        .catch(onError);
      return () => {
        disposed = true;
        stop?.();
      };
    },
  };
}
