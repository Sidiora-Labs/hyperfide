// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@hyperfide/plugin-sdk/testing/app";
import type { ModalLaunchOptions } from "./launch-options.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const launchOptions: ModalLaunchOptions = {
  presets: [
    { name: "Standard", cpu: 1, memoryMiB: 2048 },
    { name: "Large", cpu: 2, memoryMiB: 4096 },
  ],
  images: [
    {
      name: "Default",
      source: "dockerfile",
      dockerfile: "FROM debian:bookworm-slim\n",
    },
  ],
};

function renderSettings(
  options: ModalLaunchOptions = launchOptions,
  overrides: Record<string, () => unknown> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "launch.options": () => options,
        "launch.options.set": (input) => input,
        ...overrides,
      },
    },
  );
}

describe("Modal sandbox launch settings", () => {
  it("stacks preset fields in narrow containers and keeps a compact wide grid", async () => {
    const slot = renderSettings();
    const name = await slot.findByRole("textbox", { name: "Preset 1 name" });
    const row = name.parentElement?.parentElement;

    expect(row?.className).toContain("grid-cols-1");
    expect(row?.className).toContain(
      "@min-[32rem]/preset-grid:grid-cols-[minmax(0,1fr)_5rem_7rem_2rem]",
    );
    expect(slot.getByRole("spinbutton", { name: "Standard CPU" })).toBeTruthy();
    expect(
      slot.getByRole("spinbutton", { name: "Standard memory MiB" }),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "Remove Standard" })).toBeTruthy();
  });

  it("saves edited preset values through the launch options RPC", async () => {
    const slot = renderSettings();
    const cpu = await slot.findByRole("spinbutton", { name: "Standard CPU" });

    fireEvent.change(cpu, { target: { value: "1.5" } });
    fireEvent.click(slot.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "launch.options.set",
        input: expect.objectContaining({
          presets: [
            { name: "Standard", cpu: 1.5, memoryMiB: 2048 },
            { name: "Large", cpu: 2, memoryMiB: 4096 },
          ],
        }),
      }),
    );
    expect(slot.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("reports launch option load failures", async () => {
    const slot = renderSettings(launchOptions, {
      "launch.options": () => {
        throw new Error("Modal account is unavailable");
      },
    });

    expect((await slot.findByRole("alert")).textContent).toContain(
      "Modal account is unavailable",
    );
  });
});
