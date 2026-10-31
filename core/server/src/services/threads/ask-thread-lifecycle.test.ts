import { expect, it } from "vitest";
import { createAskThreadOperations, type AskThreadSdk } from "./ask-thread-lifecycle.js";
// Plugins load outside the server's compilation root, as they do in production.
const pluginModule = new URL("../../../../../plugins/hyperfide-asks/src/server.ts", import.meta.url).href;
const { createAskThreadService } = await import(pluginModule);
interface AskRow {
  id: string; task: string; session?: string | null; kind: string; question: string;
  status: string; recommendation?: string; answer?: string; secret_ref?: string;
}
type AskPolicy = "block" | "proceed-and-flag";
interface AskBridge {
  policy(): Promise<Record<string, AskPolicy>>;
  list(): Promise<AskRow[]>;
  watch(repository: string, changed: () => void): () => void;
}

const policies: Record<string, AskPolicy> = {
  secret: "block", variable: "block",
  permission: "block", decision: "proceed-and-flag",
  question: "proceed-and-flag", custom: "proceed-and-flag",
};

/** Scripted echo provider: the transcript includes every delivered input and output. */
class EchoProvider implements AskThreadSdk {
  onAsk: (row: AskRow) => void = () => {};
  raise(row: AskRow) { this.onAsk(row); }
  running = true;
  stops: string[] = [];
  transcript: string[] = [];
  metadata = new Map<string, Record<string, unknown>>();
  async stop({ threadId }: { threadId: string }) { this.stops.push(threadId); this.running = false; }
  async send({ input }: Parameters<AskThreadSdk["send"]>[0]) {
    this.running = true;
    for (const item of input) this.transcript.push(item.text, `echo: ${item.text}`);
  }
  async updatePluginMetadata({ threadId, set }: Parameters<AskThreadSdk["updatePluginMetadata"]>[0]) {
    this.metadata.set(threadId, { ...this.metadata.get(threadId), ...set });
  }
}

function fixture(initial: AskRow[], policyTable = policies) {
  const sdk = new EchoProvider();
  let rows = initial;
  let changed = () => {};
  let watching = false;
  const bridge: AskBridge = {
    async policy() { return policyTable; },
    async list() { return rows; },
    watch(_repository, listener) { changed = listener; watching = true; return () => { watching = false; }; },
  };
  const service = createAskThreadService({
    repository: "repo", bridge, operations: createAskThreadOperations(sdk),
    threads: { async list() { return [
      { repository: "repo", task: "task", id: "session" },
      { repository: "repo", task: "task", id: "other" },
      { repository: "elsewhere", task: "task", id: "foreign" },
    ]; } },
  });
  sdk.onAsk = row => { rows = [...rows, row]; changed(); };
  return { ...service, sdk, watching: () => watching,
    update(next: AskRow[]) { rows = next; changed(); },
  };
}

const ask = (kind: string, id = "1"): AskRow => ({
  id, task: "task", session: "session", kind, question: "Provide input", status: "open", recommendation: "recommended",
});

for (const kind of ["secret", "variable", "permission"]) {
  it(`echo provider pauses and resumes for ${kind}`, async () => {
    const row = ask(kind);
    const f = fixture([]);
    await f.lifecycle.start((error: unknown) => { throw error; });
    f.sdk.raise(row);
    await f.lifecycle.sync();
    expect(f.sdk.running).toBe(false);
    expect(f.sdk.stops).toEqual(["session"]);
    expect(f.sdk.metadata.get("session")?.askPause).toMatchObject({ askId: "1", reason: "Awaiting Ask 1: Provide input" });
    f.update([{ ...row, status: "answered", answer: "sensitive-test-value", secret_ref: "deploy-token" }]);
    await f.lifecycle.sync();
    expect(f.sdk.running).toBe(true);
    expect(f.sdk.transcript[0]).toContain(kind === "secret" ? "secret-ref:deploy-token" : "sensitive-test-value");
    if (kind === "secret") expect(JSON.stringify(f.sdk)).not.toContain("sensitive-test-value");
    expect(f.sdk.metadata.get("session")?.askPause).toBeNull();
    await f.lifecycle.sync();
    expect(f.sdk.transcript).toHaveLength(2);
    await f.lifecycle.dispose();
    expect(f.watching()).toBe(false);
  });
}

for (const kind of ["decision", "question", "custom"]) {
  it(`echo provider proceeds with ${kind} and flags the thread and board`, async () => {
    const f = fixture([]);
    await f.lifecycle.start((error: unknown) => { throw error; });
    f.sdk.raise(ask(kind));
    await f.lifecycle.sync();
    await f.lifecycle.sync();
    expect(f.sdk.running).toBe(true);
    expect(f.sdk.stops).toEqual([]);
    expect(f.sdk.metadata.get("session")?.["askFlag:1"]).toMatchObject({ flagged: true, recommendation: "recommended" });
    expect(f.board.forTask("repo", "task")).toMatchObject({ flagged: true, annotations: [{ recommendation: "recommended" }] });
    expect(f.board.forTask("elsewhere", "task").flagged).toBe(false);
    await f.lifecycle.dispose();
  });
}

it("uses task fallback, isolates repositories and waits for every blocking answer", async () => {
  const first = { ...ask("variable"), session: null };
  const second = { ...ask("permission", "2"), session: null };
  const f = fixture([first, second]);
  await f.lifecycle.sync();
  expect(f.sdk.stops).toEqual(["session", "other", "session", "other"]);
  f.update([{ ...first, status: "answered", answer: "one" }, second]);
  await f.lifecycle.sync();
  expect(f.sdk.transcript).toEqual([]);
  f.update([{ ...first, status: "answered", answer: "one" }, { ...second, status: "answered", answer: "two" }]);
  await f.lifecycle.sync();
  expect(f.sdk.transcript[0]).toBe("Ask 1 answered: one\nAsk 2 answered: two");
});

it("refuses a raw secret answer and a missing policy", async () => {
  const row = ask("secret");
  const f = fixture([row]);
  await f.lifecycle.sync();
  f.update([{ ...row, status: "answered", answer: "sensitive-test-value" }]);
  await expect(f.lifecycle.sync()).rejects.toThrow("no secret reference");
  expect(f.sdk.running).toBe(false);
  expect(f.sdk.transcript).toEqual([]);
  await expect(fixture([ask("unknown")]).lifecycle.sync()).rejects.toThrow("Missing Ask policy");
});

it("obeys a changed policy and keeps expired blocking Asks paused", async () => {
  const f = fixture([{ ...ask("decision"), status: "expired" }], {
    ...policies, decision: "block",
  });
  await f.lifecycle.sync();
  expect(f.sdk.stops).toEqual(["session"]);
  expect(f.board.forTask("repo", "task").flagged).toBe(false);
  expect(f.sdk.running).toBe(false);
});
