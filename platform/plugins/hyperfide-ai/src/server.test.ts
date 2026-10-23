import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";
import plugin from "./server.js";
import { formatDollars, formatUsage } from "./format.js";

async function setup(enabled = true) {
  const callRpc = vi.fn();
  const host = createFakePluginHost({
    pluginId: "hyperfide-ai",
    sdk: { plugins: { callRpc } },
  });
  await host.hyperfide.storage.kv.set("enabled", enabled);
  await plugin(host.hyperfide);
  const [service] = host.harness.registrations.aiServiceRegistrations;
  if (!service?.status || !service.complete || !service.transcribe) {
    throw new Error("AI service did not register");
  }
  return { host, service, callRpc };
}

it("reports hosted accounts disabled without making a plugin or network call", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  try {
    const { service, callRpc, host } = await setup();
    await expect(service.status!()).resolves.toEqual({
      ready: false,
      message: "Hosted accounts are disabled",
    });
    await expect(
      service.complete!("Write a title", {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Hosted accounts are disabled");
    await expect(
      host.harness.behavior.callRpc("overview", null),
    ).resolves.toMatchObject({
      enabled: true,
      status: { ready: false, message: "Hosted accounts are disabled" },
      usage: null,
    });
    expect(callRpc).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retains a saved opt-out", async () => {
  const { service, callRpc } = await setup(false);
  expect(await service.status!()).toMatchObject({ ready: false });
  await expect(
    service.complete!("Write a title", {
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("off");
  expect(callRpc).not.toHaveBeenCalled();
});

describe("usage formatting", () => {
  it("formats micros as dollars", () => {
    expect(formatDollars(0)).toBe("$0.00");
    expect(formatDollars(2_500)).toBe("<$0.01");
    expect(formatDollars(2_000_000)).toBe("$2.00");
    expect(
      formatUsage({
        spentMicros: 1_234_567,
        limitMicros: 2_000_000,
        resetsAt: Date.parse("2026-09-23T00:00:00Z"),
      }),
    ).toBe("$1.23 of $2.00 today, resets 00:00 UTC");
  });
});
