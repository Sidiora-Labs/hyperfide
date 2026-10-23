// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@hyperfide/plugin-sdk/testing/app";
import definition from "../../app.js";
import { imageBuilderContract } from "./rpc.js";
import type { BuildRecord } from "./builder.js";
afterEach(cleanup);
it("starts builds through RPC, renders progress and logs, and cancels", async () => {
  const jobs: BuildRecord[] = [];
  const imageBuildStart = vi.fn(async ({ commit }: { commit: string }) => {
    const job: BuildRecord = {
      id: "build-1",
      commit,
      checkpoint: null,
      status: "running",
      steps: [
        { name: "clone", status: "running", log: "cloning repository", ms: 0 },
      ],
      timings: { started: 1, finished: null },
    };
    jobs.push(job);
    return job;
  });
  const imageBuildCancel = vi.fn(async () => {
    jobs[0].status = "cancelled";
    return null;
  });
  const app = await loadPluginApp(definition);
  const panel = app.navPanels.find((p) => p.id === "image-builder")!;
  const slot = renderSlot<{ subPath: string }, typeof imageBuilderContract>(
    panel,
    { subPath: "" },
    {
      rpc: {
        imageBuilds: async () => structuredClone(jobs),
        imageBuildStart,
        imageBuildCancel,
      },
      experimental_rpcContract: imageBuilderContract,
    },
  );
  fireEvent.change(slot.getByLabelText("Repository commit"), {
    target: { value: "b".repeat(40) },
  });
  fireEvent.click(slot.getByRole("button", { name: "Build image" }));
  await waitFor(() =>
    expect(slot.getByText("cloning repository")).toBeTruthy(),
  );
  expect(imageBuildStart).toHaveBeenCalledWith({ commit: "b".repeat(40) });
  fireEvent.click(slot.getByRole("button", { name: "Cancel build" }));
  await waitFor(() =>
    expect(slot.getByRole("status").textContent).toContain("cancelled"),
  );
  expect(imageBuildCancel).toHaveBeenCalledWith({ id: "build-1" });
});
