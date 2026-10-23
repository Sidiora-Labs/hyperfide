// Local 3.1 projection: replace this adapter with the merged Ask bridge.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
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
  constructor(
    private repositories: string[],
    private binary = "hyperfide",
  ) {}
  private async run(repository: string, args: string[]) {
    try {
      return (await execute(this.binary, args, { cwd: repository })).stdout;
    } catch {
      throw new Error("Ask command failed");
    }
  }
  async list(): Promise<Ask[]> {
    return (
      await Promise.all(
        this.repositories.map(async (repository) => {
          const result = JSON.parse(
            await this.run(repository, ["ask", "list", "--all", "--json"]),
          );
          return result.asks.map((ask: Record<string, unknown>) => ({
            ...ask,
            repository,
            id: Number(ask.id),
            task: String(ask.task ?? ""),
            kind: ask.kind as Kind,
            question: String(ask.question ?? ask.title ?? ""),
            options: (ask.options ?? []) as string[],
            recommendation: String(ask.recommendation ?? ask.recommended ?? ""),
            status: String(ask.status ?? ask.state),
            deadline: ask.deadline as Ask["deadline"],
          }));
        }),
      )
    ).flat();
  }
  async answer(ask: Ask, value: string, note: string) {
    await this.run(ask.repository, [
      "ask",
      "answer",
      String(ask.id),
      value,
      "-m",
      note,
    ]);
  }
}
