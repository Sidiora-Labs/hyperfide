// UI compatibility adapter for the Ask store RPCs; context is supplied by the thread binding.
export interface Ask {
  id: string;
  repository: string;
  task: string;
  kind: string;
  question: string;
  status: string;
  deadline: string | number | null;
  answer?: string | null;
  note?: string | null;
}

export interface QuestionContext {
  repository: string;
  task: string;
}

export type BridgeCall = <T>(
  method: string,
  input: Record<string, string>,
) => Promise<T>;

export function createAskBridge(call: BridgeCall) {
  return {
    list: async () => {
      const result = await call<{
        asks: (Omit<Ask, "id" | "task"> & {
          id: string | number;
          task: string | null;
        })[];
      }>("list", {});
      return {
        asks: result.asks.map((row) => ({
          ...row,
          id: String(row.id),
          task: row.task ?? "",
        })),
      };
    },
    policy: () =>
      call<Record<string, "block" | "proceed-and-flag">>("policy", {}),
    context: (threadId: string, projectId: string) =>
      call<QuestionContext>("context", { threadId, projectId }),
    get: async (repository: string, id: string) => {
      const row = await call<Ask | null>("get", { repository, id });
      if (!row) throw new Error("Unknown Ask");
      return { ...row, repository, id: String(row.id), task: row.task ?? "" };
    },
  };
}

export type AskBridge = ReturnType<typeof createAskBridge>;
