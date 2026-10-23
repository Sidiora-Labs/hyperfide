import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { graphWorkerMcp, WORKER_SKILL } from "./worker-injection.js";
import { registerGraphWorker } from "./graph-lifecycle-projection.js";
import type { WorkerCapability } from "../../../../packages/provider-bridge-protocol/src/worker-mcp.js";

const root = mkdtempSync(join(tmpdir(), "hyperfide-worker-"));
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("attaches the graph capability in thread info and persists repository opt-out", () => {
  mkdirSync(join(root, ".codegraph"), { recursive: true });
  mkdirSync(join(root, "src"));
  let info!: (threadId: string) => WorkerCapability[];
  let setting!: (cwd: string, enabled: boolean) => void;
  registerGraphWorker({
    threadContext: (threadId) => ({ cwd: join(root, "src"), threadId, task: "hyperfide-v22/1.4" }),
    registerThreadInfo: (id, read) => {
      expect(id).toBe("hyperfide-worker");
      info = read;
    },
    registerRepositorySetting: (_id, set) => {
      setting = set;
    },
  });
  expect(info("thread")).toEqual([
    expect.objectContaining({
      instructions: WORKER_SKILL,
      mcpServers: {
        codify: { command: "hyperfide", args: ["mcp"], env: { CG_TASK: "hyperfide-v22/1.4" } },
      },
    }),
  ]);
  setting(root, false);
  expect(info("thread")).toEqual([]);
  expect(graphWorkerMcp({ cwd: root, threadId: "other" })).toBeNull();
  setting(root, true);
  expect(info("thread")).toHaveLength(1);
});

it("adds nothing without a graph and rejects malformed repository configuration", () => {
  mkdirSync(root, { recursive: true });
  expect(graphWorkerMcp({ cwd: root, threadId: "thread" })).toBeNull();
  mkdirSync(join(root, ".codegraph"));
  expect(graphWorkerMcp({ cwd: root, threadId: "thread" })?.mcpServers.codify.env).toEqual({});
  writeFileSync(join(root, ".codegraph", "worker-injection.json"), '{"enabled":"false"}');
  expect(() => graphWorkerMcp({ cwd: root, threadId: "thread" })).toThrow("boolean enabled");
});
