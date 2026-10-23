// Task 3.1 has not landed. Reconcile this narrow RPC adapter with its bridge.
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
    list: () => call<{ asks: Ask[] }>("list", {}),
    policy: () =>
      call<Record<string, "block" | "proceed-and-flag">>("policy", {}),
    context: (threadId: string, projectId: string) =>
      call<QuestionContext>("context", { threadId, projectId }),
    get: (repository: string, id: string) =>
      call<Ask>("get", { repository, id }),
  };
}

export type AskBridge = ReturnType<typeof createAskBridge>;
