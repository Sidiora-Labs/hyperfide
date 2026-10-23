import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import plugin from "../../hyperfide-graph/server.js";

it("reads the relay state for the Index panel and falls back quietly", async () => {
  const fake = createFakePluginHost({ pluginId: "hyperfide-graph" });
  const api = Object.values(fake).find(value => "hosts" in value) as Parameters<typeof plugin>[0];
  plugin(api);
  const fetchStatus = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hostId: "host-a", status: "running" }) });
  vi.stubGlobal("fetch", fetchStatus);
  vi.stubEnv("HYPERFIDE_HOST_DAEMON_PORT", "1234");
  const scope = { hostId: "host-a", repository: "/repo" };
  try {
    expect(await fake.harness.callRpc("languageServerStatus", scope)).toBe("running");
    expect(String(fetchStatus.mock.calls[1]?.[0])).toContain("repository=%2Frepo");
    fetchStatus.mockRejectedValueOnce(new Error("offline"));
    expect(await fake.harness.callRpc("languageServerStatus", scope)).toBe("stopped");
    fetchStatus.mockResolvedValueOnce({ ok: true, json: async () => ({ hostId: "other" }) });
    expect(await fake.harness.callRpc("languageServerStatus", scope)).toBe("stopped");
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
