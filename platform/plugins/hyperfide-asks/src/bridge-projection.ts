// Inbox compatibility adapter for the shared Ask bridge.
import { AskBridge as StoreBridge } from "./bridge.js";
import { localGraphHost } from "./graph-host-projection.js";
export type Kind =
  | "secret"
  | "variable"
  | "permission"
  | "decision"
  | "question";
export interface Ask {
  id: number;
  repository: string;
  task: string;
  kind: Kind;
  question: string;
  options: string[];
  recommendation: string;
  status: string;
  deadline?: string | number | null;
  sensitive?: boolean;
}
export interface AskBridge {
  list(): Promise<Ask[]>;
  answer(ask: Ask, value: string, note: string): Promise<void>;
}
export class BinaryAskBridge implements AskBridge {
  private bridge: StoreBridge;
  constructor(
    private repositories: string[],
    binary?: string,
    bridge?: StoreBridge,
  ) {
    this.bridge = bridge ?? new StoreBridge(localGraphHost(binary), () => {});
  }
  async list(): Promise<Ask[]> {
    return (
      await Promise.all(
        this.repositories.map(async (repository) =>
          (await this.bridge.list(repository)).map((ask) => ({
            ...ask,
            repository,
            id: Number(ask.id),
            task: ask.task ?? "",
            kind: ask.kind as Kind,
            recommendation: ask.recommendation ?? "",
          })),
        ),
      )
    ).flat();
  }
  async answer(ask: Ask, value: string, note: string) {
    await this.bridge.answer(ask.repository, String(ask.id), value, note);
  }
}
