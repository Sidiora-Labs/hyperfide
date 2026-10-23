import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
const scope = { hostId: "host-a", repository: "/repo" };
const result = {
  binary: {
    path: "/repo/cg",
    version: "Hyperfide 22",
    digest: "a".repeat(64),
    ok: true,
  },
  data: { status: "ready", symbols: 8 },
};
function setup(call: (input: unknown) => unknown = () => result) {
  const fake = createFakePluginHost({
    pluginId: "hyperfide-graph",
    experimental_callHostRpc: ({ input }) => call(input),
  });
  const api = Object.values(fake).find(
    (value) => "hosts" in value,
  ) as Parameters<typeof plugin>[0];
  plugin(api);
  return fake.harness;
}
describe("Graph RPC and CLI", () => {
  it("routes all commands to the selected host with JSON results", async () => {
    const inputs: unknown[] = [];
    const host = setup((input) => {
      inputs.push(input);
      return result;
    });
    for (const command of ["survey", "context", "index-status", "why"]) {
      expect(
        await host.callRpc("run", {
          ...scope,
          command,
          ...(command === "index-status" ? {} : { target: "src" }),
        }),
      ).toEqual(result);
    }
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toMatchObject({ ...scope, timeoutMs: 15000 });
    expect(
      (
        await host.runCli([
          "status",
          "--host",
          scope.hostId,
          "--repository",
          scope.repository,
        ])
      ).stdout,
    ).toContain("Hyperfide 22");
  });
  it("rejects invalid requests and host results", async () => {
    const host = setup();
    for (const input of [
      { ...scope, command: "rm" },
      { ...scope, command: "survey", target: "--help" },
      { ...scope, command: "why" },
      { ...scope, command: "index-status", shell: true },
    ]) {
      await expect(host.callRpc("run", input)).rejects.toThrow();
    }
    await expect(
      setup(() => ({ data: {} })).callRpc("run", {
        ...scope,
        command: "index-status",
      }),
    ).rejects.toThrow();
  });
  it("persists enable and binary settings per repository", async () => {
    const host = setup();
    expect(await host.callRpc("getSettings", scope)).toEqual({ enabled: true });
    await host.callRpc("setSettings", {
      ...scope,
      settings: { enabled: false, binaryPath: "/custom/cg" },
    });
    await expect(
      host.callRpc("run", { ...scope, command: "index-status" }),
    ).rejects.toThrow(/disabled/);
    expect(
      await host.callRpc("getSettings", { ...scope, repository: "/other" }),
    ).toEqual({ enabled: true });
    await host.callRpc("setSettings", {
      ...scope,
      settings: { enabled: true, binaryPath: "/custom/cg" },
    });
    await host.callRpc("run", { ...scope, command: "index-status" });
    expect(host.experimental_hostRpcCalls.at(-1)?.input).toMatchObject({
      binaryPath: "/custom/cg",
    });
  });
  it("bounds an unresponsive host and reports missing binaries", async () => {
    vi.useFakeTimers();
    try {
      const host = setup(() => new Promise(() => {}));
      const pending = expect(
        host.callRpc("run", { ...scope, command: "index-status" }),
      ).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(15001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
    await expect(
      setup(() => {
        throw new Error("Hyperfide binary missing");
      }).callRpc("run", { ...scope, command: "index-status" }),
    ).rejects.toThrow(/binary missing/);
  });
});
