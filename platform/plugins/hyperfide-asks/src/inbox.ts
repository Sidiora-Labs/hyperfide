import type { Ask, AskBridge, Kind } from "./bridge-projection.js";
export interface AnswerInput {
  repository: string;
  id: number;
  value: string;
  note?: string;
  operator?: string;
  sensitive?: boolean;
}
export function filterAsks(asks: Ask[], kind?: string, task?: string) {
  return asks.filter(
    (a) =>
      a.status === "open" &&
      (!kind || a.kind === kind) &&
      (!task || a.task === task),
  );
}
export function countdown(deadline: Ask["deadline"], now = Date.now()): string {
  if (!deadline) return "No deadline";
  const end =
    typeof deadline === "number" ? deadline * 1000 : Date.parse(deadline);
  if (!Number.isFinite(end)) return "No deadline";
  const minutes = Math.ceil((end - now) / 60000);
  return minutes <= 0 ? "Overdue" : `${minutes}m remaining`;
}
export const kinds: Kind[] = [
  "secret",
  "variable",
  "permission",
  "decision",
  "question",
];
export class InboxService {
  constructor(
    private bridge: AskBridge,
    private store: (value: string) => Promise<string>,
  ) {}
  async list(filter: { kind?: string; task?: string } = {}) {
    return filterAsks(await this.bridge.list(), filter.kind, filter.task);
  }
  async answer(input: AnswerInput) {
    const ask = (await this.list()).find(
      (a) => a.id === input.id && a.repository === input.repository,
    );
    if (!ask) throw new Error("Open Ask not found");
    if (!input.value.trim()) throw new Error("Answer required");
    const secret =
      ask.kind === "secret" ||
      (ask.kind === "variable" && (ask.sensitive || input.sensitive));
    let note = secret ? "" : (input.note ?? "");
    let operator: string | undefined;
    if (ask.kind === "permission") {
      operator = input.operator?.trim();
      if (!operator || /[\r\n]/.test(operator))
        throw new Error("Operator identity required");
      if (!["approve", "reject"].includes(input.value))
        throw new Error("Grant or refuse required");
      note = `${note}${note ? "\n" : ""}Operator: ${operator}`;
    } else if (
      !secret &&
      ask.options?.length &&
      !ask.options.includes(input.value)
    ) {
      throw new Error("Choose an offered option");
    }
    const value = secret
      ? `secret-ref:${await this.store(input.value)}`
      : input.value;
    await this.bridge.answer(ask, value, note);
    return {
      id: ask.id,
      repository: ask.repository,
      answer: value,
      note,
      ...(operator ? { operator } : {}),
    };
  }
}
