import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { NamedSecretStore } from "../../secrets/src/named-store.js";
import { BinaryAskBridge, type Ask } from "./inbox-adapter.js";
import { AskBridge as StoreBridge } from "./bridge.js";
import { localGraphHost } from "./graph-host.js";
import { InboxService, filterAsks } from "./inbox.js";
import { registerInbox } from "./server.js";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const row = (kind: Ask["kind"], id = 1): Ask => ({
  id,
  kind,
  repository: "repo",
  task: "3.3",
  question: "Choose?",
  options: [],
  recommendation: "",
  status: "open",
});
describe("Inbox RPC", () => {
  it("lists open Asks across repositories and filters by kind and task", async () => {
    const rows = [
      row("secret"),
      { ...row("variable", 2), repository: "other", task: "3.1" },
      { ...row("question", 3), status: "answered" },
    ];
    const host = createFakePluginHost({ pluginId: "hyperfide-asks" });
    registerInbox(host.hyperfide as unknown as Parameters<typeof registerInbox>[0], {
      list: async () => rows,
      answer: async () => {},
    });
    expect(await host.harness.behavior.callRpc("inboxList", {})).toHaveLength(
      2,
    );
    expect(
      await host.harness.behavior.callRpc("inboxList", { kind: "secret" }),
    ).toEqual([rows[0]]);
    expect(
      await host.harness.behavior.callRpc("inboxList", { task: "3.1" }),
    ).toEqual([rows[1]]);
    expect(filterAsks(rows, "secret", "3.1")).toEqual([]);
  });
  it("routes secret RPC answers through the secrets plugin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperfide-rpc-"));
    directories.push(directory);
    const store = new NamedSecretStore(directory);
    const writes: string[] = [];
    const host = createFakePluginHost({
      pluginId: "hyperfide-asks",
      sdk: {
        plugins: {
          async callRpc(input) {
            expect(input.pluginId).toBe("hyperfide-secrets");
            expect(input.method).toBe("storeReference");
            return {
              name: await store.store((input.input as { value: string }).value),
            };
          },
        },
      },
    });
    registerInbox(host.hyperfide as unknown as Parameters<typeof registerInbox>[0], {
      list: async () => [row("secret")],
      answer: async (_ask, value, note) => {
        writes.push(value, note);
      },
    });
    const value = crypto.randomUUID();
    const result = await host.harness.behavior.callRpc("inboxAnswer", {
      repository: "repo",
      id: 1,
      value,
      note: value,
    });
    expect(JSON.stringify({ result, writes }).includes(value)).toBe(false);
    expect(writes[0]).toMatch(/^secret-ref:ask-/);
    expect(writes[1]).toBe("");
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect((await readFile(join(directory, names[0]!), "utf8")) === value).toBe(
      true,
    );
  });
  it("answers every kind through the real binary and never records secret values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyperfide-inbox-"));
    directories.push(directory);
    const binary = resolve("../../../platform/cg");
    const run = (...args: string[]) =>
      execFileSync(binary, args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    run("init");
    const store = new NamedSecretStore(join(directory, "private"));
    const bridge = new BinaryAskBridge([directory], new StoreBridge(localGraphHost(binary), () => {}));
    const service = new InboxService(bridge, (value) => store.store(value));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = `credential-${crypto.randomUUID()}`;
    const answers: unknown[] = [];
    for (const kind of [
      "secret",
      "variable",
      "permission",
      "decision",
      "question",
    ] as const) {
      const args = ["ask", "raise", kind, `Need ${kind}`, "--json"];
      if (kind === "decision" || kind === "question")
        args.push("--option", "a", "--option", "b", "--recommend", "a");
      const id = JSON.parse(run(...args)).id;
      const value =
        kind === "secret"
          ? raw
          : kind === "permission"
            ? "approve"
            : kind === "variable"
              ? "plain"
              : "b";
      answers.push(
        await service.answer({
          repository: directory,
          id,
          value,
          operator: "operator@example.test",
          note: "chosen",
        }),
      );
    }
    for (const sensitive of [true, false]) {
      const id = JSON.parse(
        run(
          "ask",
          "raise",
          sensitive ? "variable" : "permission",
          "Additional answer",
          "--json",
        ),
      ).id;
      answers.push(
        await service.answer({
          repository: directory,
          id,
          value: sensitive ? raw : "reject",
          sensitive,
          operator: "operator@example.test",
          note: sensitive ? raw : "refused",
        }),
      );
    }
    const records = await bridge.list();
    expect(records.every((a) => a.status === "answered")).toBe(true);
    const all = run("ask", "list", "--all", "--json");
    const events = run("events", "--json", "-n", "100");
    expect(
      JSON.stringify({
        answers,
        records,
        all,
        events,
        logs: log.mock.calls,
        errors: error.mock.calls,
      }).includes(raw),
    ).toBe(false);
    expect(JSON.stringify(answers)).toContain(
      "Operator: operator@example.test",
    );
    expect(
      answers.filter((a) => (a as { operator?: string }).operator),
    ).toHaveLength(2);
    const files = await readdir(join(directory, "private"));
    expect(files).toHaveLength(2);
    for (const name of files) {
      expect(
        (await readFile(join(directory, "private", name), "utf8")) === raw,
      ).toBe(true);
      expect((await stat(join(directory, "private", name))).mode & 0o777).toBe(
        0o600,
      );
      expect(all).toContain(`secret-ref:${name}`);
    }
  }, 60_000);
  it("validates options and permission identity before writing", async () => {
    const answer = vi.fn();
    const store = vi.fn();
    const service = new InboxService(
      { list: async () => [row("permission")], answer },
      store,
    );
    await expect(
      service.answer({ repository: "repo", id: 1, value: "approve" }),
    ).rejects.toThrow("identity");
    await expect(
      service.answer({
        repository: "repo",
        id: 1,
        value: "other",
        operator: "human",
      }),
    ).rejects.toThrow("Grant");
    const decision = new InboxService(
      { list: async () => [{ ...row("decision"), options: ["a"] }], answer },
      store,
    );
    await expect(
      decision.answer({ repository: "repo", id: 1, value: "b" }),
    ).rejects.toThrow("option");
    expect(answer).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});
