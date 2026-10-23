import { AskBridge, mirror, type Ask } from "../hyperfide-asks/src/bridge";
import { binaryCommand, type SpecCommand } from "../hyperfide-spec/src/reader";
import type { PermissionAsk, PublicationAsks } from "../hyperfide-spec/wave-authority";

/** Permission answers come from the Ask journal's authenticated answer identity. */
export function publicationAsks(repository: string, bridge: AskBridge,
  command: SpecCommand = binaryCommand()): PublicationAsks {
  const permission = (ask: Ask): PermissionAsk => {
    if (ask.kind !== "permission") throw new Error("Expected permission Ask");
    return {
      id: String(ask.id), kind: "permission", binding: ask.body,
      status: ask.state === "answered" ? "answered" : "open",
      answer: ask.answer === "grant" || ask.answer === "refuse" ? ask.answer : undefined,
      operator: typeof ask.answered_by === "string" && ask.answered_by !== "default"
        && ask.decided_by_default !== true ? ask.answered_by : undefined,
    };
  };
  return {
    policy: async () => ({ blocks: (await bridge.policy(repository)).permission === "block" }),
    raise: async input => permission(mirror(await command([
      "ask", "raise", "permission", input.question, "--body", input.binding,
      "--option", "grant", "--option", "refuse", "--json",
    ], repository))),
    get: async id => {
      const ask = await bridge.get(repository, id);
      if (!ask) throw new Error("Unknown publication Ask");
      return permission(ask);
    },
  };
}
