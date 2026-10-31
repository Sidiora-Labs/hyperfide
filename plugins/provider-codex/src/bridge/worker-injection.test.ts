import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@hyperfide/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

it.each(["graph", "plain", "disabled"])(
  "worker injection: %s repository",
  async (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), "hyperfide-worker-codex-"));
    if (mode !== "plain") mkdirSync(join(cwd, ".codegraph"));
    if (mode === "disabled")
      writeFileSync(
        join(cwd, ".codegraph", "worker-injection.json"),
        '{"enabled":false}',
      );
    const requestLogPath = join(cwd, "requests.jsonl");
    const script = join(cwd, "script.json");
    writeFileSync(script, JSON.stringify({ requestLogPath }));
    stubFakeCodexAppServer(script);
    const harness = createHarness(handleLine);
    const threadId = `hyperfide-worker-${mode}`;
    try {
      harness.sendRequest(1, "thread/start", {
        cwd,
        threadId,
        task: "hyperfide-v22/1.4",
        instructionMode: "append",
        options: FULL_ACCESS_SESSION_OPTIONS,
      });
      const response = await harness.waitForResponse(1);
      expect(response.error).toBeUndefined();
      const active = mode === "graph";
      expect(
        (response.result as { attachedCapabilities?: unknown[] })
          .attachedCapabilities ?? [],
      ).toEqual(
        active ? [expect.objectContaining({ id: "hyperfide-worker" })] : [],
      );
      const requests = readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const params = requests.find(
        (request) => request.method === "thread/start",
      ).params;
      if (active) {
        expect(params.config.mcp_servers.codify).toEqual({
          command: "hyperfide",
          args: ["mcp"],
          env: { CG_TASK: "hyperfide-v22/1.4" },
        });
        expect(params.developerInstructions).toContain(
          "survey the area, then context",
        );
      } else {
        expect(params.config.mcp_servers).toBeUndefined();
        expect(params.developerInstructions).toBeUndefined();
      }
    } finally {
      harness.sendRequest(2, "thread/stop", {
        threadId,
        providerThreadId: "cleanup",
        intent: "release",
        activeTurnId: null,
      });
      await harness.waitForResponse(2);
      harness.restore();
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  30_000,
);
