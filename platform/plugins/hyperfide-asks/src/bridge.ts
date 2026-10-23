import type { PluginStorage } from '@hyperfide/authority';
import { openAskStorage } from './storage.js';
import { join } from "node:path";
import type { GraphHost } from "./graph-host-projection.js";
export type Policy = Record<string, "block" | "proceed-and-flag">;
export const fallbackPolicy: Policy = {
  secret: "block",
  variable: "block",
  permission: "block",
  decision: "proceed-and-flag",
  question: "proceed-and-flag",
};
export interface Ask extends Record<string, unknown> {
  id: string | number;
  kind: string;
  task: string | null;
  title: string;
  body: string;
  options: string[];
  recommended: string | null;
  state: string;
  deadline: number | null;
  raised: number;
  question: string;
  recommendation: string | null;
  status: string;
  raised_at: number;
}
export function mirror(value: unknown): Ask {
  if (!value || typeof value !== "object") throw new Error("Invalid ask row");
  const row = value as Ask;
  if (
    (typeof row.id !== "string" &&
      !(typeof row.id === "number" && Number.isSafeInteger(row.id))) ||
    typeof row.kind !== "string" ||
    typeof row.title !== "string" ||
    typeof row.state !== "string" ||
    !Array.isArray(row.options) ||
    !row.options.every((x) => typeof x === "string") ||
    typeof row.raised !== "number"
  )
    throw new Error("Invalid ask row");
  return {
    ...row,
    question: [row.title, row.body].filter(Boolean).join("\n\n"),
    recommendation: row.recommended,
    status: row.state,
    raised_at: row.raised,
  };
}
export function parsePolicy(text: string | null): Policy {
  const section = text?.match(
    /^\[asks\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
  )?.[1];
  if (!section) return { ...fallbackPolicy };
  const kindsText = section.match(/^kinds\s*=\s*(\[[\s\S]*?\])/m)?.[1];
  const kinds: unknown = kindsText
    ? JSON.parse(kindsText)
    : Object.keys(fallbackPolicy);
  if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === "string"))
    throw new Error("Invalid ask kinds");
  const entries = new Map(
    [...section.matchAll(/^([\w-]+)\s*=\s*"(block|proceed-and-flag)"/gm)].map(
      (m) => [m[1]!, m[2]!],
    ),
  );
  return Object.fromEntries(
    kinds.map((k) => {
      const policy = entries.get(k) ?? fallbackPolicy[k];
      if (!policy) throw new Error("Missing ask kind policy");
      return [k, policy];
    }),
  ) as Policy;
}
export class AskBridge {
  constructor(
    private graph: GraphHost,
    private publish: (channel: string, payload: unknown) => void,
    private storage?: PluginStorage,
  ) {}
  private async command(repository: string, args: string[]) {
    const { root, hostId } = await this.graph.resolveRepository(repository);
    const binary = await this.graph.binaryPath(hostId);
    // Child errors may contain answers in argv; never forward them.
    try {
      return await this.graph.exec(hostId, { binary, args, cwd: root });
    } catch {
      throw new Error("Hyperfide ask command failed");
    }
  }
  async list(repository: string): Promise<Ask[]> {
    const data = JSON.parse(
      await this.command(repository, ["ask", "list", "--all", "--json"]),
    );
    if (!Array.isArray(data.asks)) throw new Error("Invalid ask list");
    const asks: Ask[] = data.asks.map(mirror);
    const storage = this.storage ?? await openAskStorage(repository);
    try { await storage.put('mirror', asks); }
    finally { if (!this.storage) storage.close(); }
    return asks;
  }
  async get(repository: string, id: string) {
    return (
      (await this.list(repository)).find((row) => String(row.id) === id) ?? null
    );
  }
  async answer(repository: string, id: string, answer: string, note?: string) {
    const row = await this.get(repository, id);
    if (!row) throw new Error("Unknown Ask");
    if (
      row.kind === "secret" &&
      (!/^secret-ref:[A-Za-z0-9_.\/-]+$/.test(answer) ||
        (note !== undefined && note !== ""))
    )
      throw new Error("Secret answers require a secret reference and no note");
    if (row.options.length && !row.options.includes(answer))
      throw new Error("Answer must be an offered option");
    if (!answer || answer.startsWith("-") || id.startsWith("-"))
      throw new Error("Invalid answer arguments");
    await this.command(repository, [
      "ask",
      "answer",
      id,
      answer,
      ...(note === undefined || row.kind === "secret" ? [] : ["-m", note]),
      "--json",
    ]);
    const asks = await this.list(repository);
    this.publish("asks.changed", { repository, asks });
    return asks.find((ask) => String(ask.id) === id) ?? null;
  }
  async journal(repository: string) {
    const output = await this.command(repository, [
      "events",
      "--kind",
      "ask.",
      "--json",
    ]);
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === "ask.answered");
  }
  async policy(repository: string) {
    const { root, hostId } = await this.graph.resolveRepository(repository);
    return parsePolicy(
      await this.graph.readText(hostId, join(root, "spec/workflow.kvx")),
    );
  }
  async watch(repository: string, changed?: () => void): Promise<() => void> {
    const { root, hostId } = await this.graph.resolveRepository(repository);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue = Promise.resolve();
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        queue = queue.then(async () => {
          if (stopped) return;
          try {
            const asks = await this.list(repository);
            if (!stopped) {
              this.publish("asks.changed", { repository, asks });
              changed?.();
            }
          } catch {
            if (!stopped)
              this.publish("asks.error", {
                repository,
                message: "Ask refresh failed",
              });
          }
        });
      }, 40);
    };
    const stop = await this.graph.watch(
      hostId,
      [
        join(root, ".codegraph/graph.db"),
        join(root, ".codegraph/graph.db-wal"),
      ],
      refresh,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
      stop();
    };
  }
}
