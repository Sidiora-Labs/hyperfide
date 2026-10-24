import { describe, it, expect, vi } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import { createRailwayPlugin } from "../server.js";
import type { RailwayClient, SandboxMachine } from "./machine-ops.js";
import { railwayIdentity } from "./status.js";
import { enrollRailwayHost, readBootstrapState } from "./fleet-bootstrap.js";
const credentials = {
  HYPERFIDE_RAILWAY_API_TOKEN: "test-private-token-12345",
  HYPERFIDE_RAILWAY_ENV_ID: "test-private-environment-12345",
};
function fixture() {
  const { hyperfide, harness: host } = createFakePluginHost();
  const list = vi.fn(async () => [
    { id: "sandbox", status: "RUNNING", region: "eu-west" },
  ]);
  const factory = vi.fn(() => ({ list }) as unknown as RailwayClient);
  const identity = vi.fn(async () => ({
    projectName: "My project",
    environmentName: "Production",
  }));
  createRailwayPlugin(factory, identity)(hyperfide);
  return { host, hyperfide, factory, list, identity };
}
describe("Railway status RPC", () => {
  it("reports unconfigured without contacting Railway", async () => {
    const f = fixture();
    expect(await f.host.callRpc("railwayStatus", {})).toMatchObject({
      configured: false,
      verifiedAt: null,
      machineCount: 0,
      bootstrap: { phase: "not-started" },
    });
    await f.host.callRpc("railwayVerify", {});
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("verifies stored settings and persists a secret-free identity and fleet summary", async () => {
    const f = fixture();
    await f.host.setSettings(credentials);
    await f.hyperfide.storage.kv.set("railway/allocation/a", {
      id: "sandbox",
      checkpoint: null,
    });
    await f.hyperfide.storage.kv.set("railway/allocation/b", {
      id: null,
      checkpoint: "saved",
    });
    const status = await f.host.callRpc("railwayVerify", {});
    expect(status).toMatchObject({
      configured: true,
      verifiedAt: expect.any(String),
      projectName: "My project",
      environmentName: "Production",
      region: "eu-west",
      sandboxCount: 1,
      machineCount: 2,
      machines: [{ phase: "running" }, { phase: "suspended" }],
      lastError: null,
    });
    expect(await f.host.callRpc("railwayStatus", {})).toEqual(status);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(status)).not.toContain(
      credentials.HYPERFIDE_RAILWAY_API_TOKEN,
    );
    await f.host.setSettings({ HYPERFIDE_RAILWAY_API_TOKEN: "changed-token" });
    expect(await f.host.callRpc("railwayStatus", {})).toMatchObject({
      verifiedAt: null,
    });
  });
  it("redacts failed verification and clears stale success", async () => {
    const f = fixture();
    await f.host.setSettings(credentials);
    await f.host.callRpc("railwayVerify", {});
    f.list.mockRejectedValueOnce(
      new Error(
        `${credentials.HYPERFIDE_RAILWAY_API_TOKEN} ${credentials.HYPERFIDE_RAILWAY_ENV_ID} Bearer secret-other-token`,
      ),
    );
    expect(await f.host.callRpc("railwayVerify", {})).toMatchObject({
      configured: true,
      verifiedAt: null,
      lastError: "[REDACTED] [REDACTED] [REDACTED]",
    });
  });
  it("redacts identity fields returned by Railway", async () => {
    const f = fixture();
    await f.host.setSettings(credentials);
    f.identity.mockResolvedValueOnce({
      projectName: credentials.HYPERFIDE_RAILWAY_API_TOKEN,
      environmentName: credentials.HYPERFIDE_RAILWAY_ENV_ID,
    });
    expect(await f.host.callRpc("railwayVerify", {})).toMatchObject({
      projectName: "[REDACTED]",
      environmentName: "[REDACTED]",
    });
  });
  it("requests the environment identity from Railway", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              environment: { name: "Production", project: { name: "Project" } },
            },
          }),
        ),
      );
    try {
      expect(
        await railwayIdentity({ token: "token", environmentId: "environment" }),
      ).toEqual({ projectName: "Project", environmentName: "Production" });
      expect(
        JSON.parse(String(fetcher.mock.calls[0][1]?.body)).variables,
      ).toEqual({ id: "environment" });
    } finally {
      fetcher.mockRestore();
    }
  });
  it("records bootstrap success and redacted failure", async () => {
    const f = fixture();
    const store = f.hyperfide.storage.kv;
    const machine = {} as SandboxMachine;
    const request = {
      key: "allocation",
      report: { step: async () => {}, log: async () => {} },
      signal: new AbortController().signal,
    };
    const state = {
      store,
      credentials: {
        token: credentials.HYPERFIDE_RAILWAY_API_TOKEN,
        environmentId: credentials.HYPERFIDE_RAILWAY_ENV_ID,
      },
    };
    const bootstrap = {
      bootstrap: vi.fn(async () => {
        expect(await readBootstrapState(store)).toMatchObject({
          phase: "enrolling",
        });
        return { hostId: "host" };
      }),
    };
    await enrollRailwayHost(machine, bootstrap, request, state);
    expect(await readBootstrapState(store)).toMatchObject({
      phase: "enrolled",
      updatedAt: expect.any(String),
      lastError: null,
    });
    bootstrap.bootstrap.mockRejectedValueOnce(
      new Error(credentials.HYPERFIDE_RAILWAY_API_TOKEN),
    );
    await expect(
      enrollRailwayHost(machine, bootstrap, request, state),
    ).rejects.toThrow();
    expect(await readBootstrapState(store)).toMatchObject({
      phase: "failed",
      lastError: "[REDACTED]",
    });
  });
});
