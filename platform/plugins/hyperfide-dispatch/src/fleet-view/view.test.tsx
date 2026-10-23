// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@hyperfide/plugin-sdk/testing/app";
import definition from "../../app.js";
import fixture from "./__fixtures__/ledger.json";
import { fleetRpcContract, ledgerSchema, stages } from "./contract.js";
import { createFleetHandlers, type FleetBackend } from "./rpc.js";

afterEach(cleanup);

function backend() {
  const ledger = ledgerSchema.parse(structuredClone(fixture));
  const handlers: FleetBackend = {
    readLedger: vi.fn(async () => ledger),
    cancelJob: vi.fn(async (id) => {
      ledger.jobs.find((job) => job.id === id)!.state = "cancelled";
    }),
    destroyMachine: vi.fn(async (id) => {
      ledger.machines = ledger.machines.filter((machine) => machine.id !== id);
    }),
    setPaused: vi.fn(async (paused) => {
      ledger.budget.paused = paused;
    }),
    setCap: vi.fn(async (cap) => {
      ledger.budget.cap = cap;
    }),
  };
  return { ledger, handlers, rpc: createFleetHandlers(handlers) };
}

async function mount(source = backend()) {
  const app = await loadPluginApp(definition);
  expect(app.navPanels[0]!.title).toBe("Fleet");
  const slot = renderSlot<{ subPath: string }, typeof fleetRpcContract>(
    app.navPanels[0]!,
    { subPath: "" },
    { rpc: source.rpc, experimental_rpcContract: fleetRpcContract },
  );
  await waitFor(() =>
    expect(slot.getByRole("region", { name: "Budget" })).toBeTruthy(),
  );
  return { ...source, slot };
}

describe("Fleet ledger dashboard", () => {
  it("renders machines, jobs, budget, every timeline stage and escaped log tails from ledgers", async () => {
    const { slot } = await mount();
    const machines = within(slot.getByRole("region", { name: "Machines" }));
    expect(machines.getByText("fake-provider")).toBeTruthy();
    expect(machines.getByText("running")).toBeTruthy();
    expect(machines.getByText(/^\d+s$/)).toBeTruthy();
    const jobs = within(slot.getByRole("region", { name: "Jobs" }));
    for (const text of [
      "task-42",
      "running",
      "2",
      "machine-1",
      "2026-10-23T10:00:00Z",
      "60s",
    ]) {
      expect(jobs.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(
      slot.getByText(
        /Cap: 2 \/ 8.*In flight: 1.*Keys: 3.*2026-10-23T11:00:00Z/,
      ),
    ).toBeTruthy();
    for (const stage of stages)
      expect(slot.getByText(`${stage}: 2026-10-23T10:00:00Z`)).toBeTruthy();
    expect(slot.getByLabelText("Log job-1").textContent).toContain(
      "<script>fixture</script>",
    );
    expect(slot.container.querySelector("script")).toBeNull();
  });

  it("routes all actions through the RPC to injected handlers and refreshes the view", async () => {
    const { slot, handlers } = await mount();
    fireEvent.click(slot.getByRole("button", { name: "Pause dispatch" }));
    await waitFor(() => expect(slot.getByText("Dispatch paused")).toBeTruthy());
    expect(handlers.setPaused).toHaveBeenCalledWith(true);
    fireEvent.click(slot.getByRole("button", { name: "Resume dispatch" }));
    await waitFor(() => expect(slot.getByText("Dispatch active")).toBeTruthy());
    expect(handlers.setPaused).toHaveBeenCalledWith(false);
    fireEvent.change(slot.getByLabelText("Cap"), { target: { value: "999" } });
    fireEvent.click(slot.getByRole("button", { name: "Raise cap" }));
    await waitFor(() => expect(handlers.setCap).toHaveBeenCalledWith(8));
    await waitFor(() => expect(slot.getByText(/Cap: 8 \/ 8/)).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Cancel job-1" }));
    await waitFor(() => expect(slot.getByText("cancelled")).toBeTruthy());
    expect(handlers.cancelJob).toHaveBeenCalledWith("job-1");
    fireEvent.click(slot.getByRole("button", { name: "Destroy machine-1" }));
    await waitFor(() => expect(slot.getByText("No machines")).toBeTruthy());
    expect(handlers.destroyMachine).toHaveBeenCalledWith("machine-1");
  });

  it("renders empty ledgers and pending tasks", async () => {
    const source = backend();
    source.ledger.machines = [];
    source.ledger.jobs = [];
    source.ledger.timelines = [{ task: "waiting", events: [] }];
    const { slot } = await mount(source);
    expect(slot.getByText("No machines")).toBeTruthy();
    expect(slot.getByText("No jobs")).toBeTruthy();
    for (const stage of stages)
      expect(slot.getByText(`${stage}: Pending`)).toBeTruthy();
  });

  it("shows read and action failures and allows retry", async () => {
    const source = backend();
    const app = await loadPluginApp(definition);
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockImplementation(source.rpc.fleetLedger);
    const slot = renderSlot<{ subPath: string }, typeof fleetRpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: { ...source.rpc, fleetLedger: read },
        experimental_rpcContract: fleetRpcContract,
      },
    );
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "ledger unavailable",
      ),
    );
    slot.unmount();
    const mounted = await mount(source);
    vi.mocked(source.handlers.cancelJob).mockRejectedValueOnce(
      new Error("cancel failed"),
    );
    fireEvent.click(mounted.slot.getByRole("button", { name: "Cancel job-1" }));
    await waitFor(() =>
      expect(mounted.slot.getByRole("alert").textContent).toContain(
        "cancel failed",
      ),
    );
    fireEvent.click(mounted.slot.getByRole("button", { name: "Cancel job-1" }));
    await waitFor(() =>
      expect(mounted.slot.getByText("cancelled")).toBeTruthy(),
    );
  });
});

describe("Fleet RPC boundaries", () => {
  it("clamps cap, rejects invalid targets and input, and bounds log tails", async () => {
    const { rpc, handlers, ledger } = backend();
    await rpc.fleetAction({ kind: "raiseCap", cap: 100 });
    expect(handlers.setCap).toHaveBeenLastCalledWith(8);
    await rpc.fleetAction({ kind: "raiseCap", cap: 1 });
    expect(handlers.setCap).toHaveBeenLastCalledWith(8);
    await expect(
      rpc.fleetAction({ kind: "raiseCap", cap: NaN }),
    ).rejects.toThrow();
    await expect(
      rpc.fleetAction({ kind: "cancel", id: "missing" }),
    ).rejects.toThrow("Unknown job");
    await expect(
      rpc.fleetAction({ kind: "destroy", id: "missing" }),
    ).rejects.toThrow("Unknown machine");
    expect(handlers.cancelJob).not.toHaveBeenCalled();
    expect(handlers.destroyMachine).not.toHaveBeenCalled();
    ledger.jobs[0]!.log = "x".repeat(20000) + "tail";
    const view = await rpc.fleetLedger();
    expect(view.jobs[0]!.log.length).toBe(16384);
    expect(view.jobs[0]!.log.endsWith("tail")).toBe(true);
  });
});
