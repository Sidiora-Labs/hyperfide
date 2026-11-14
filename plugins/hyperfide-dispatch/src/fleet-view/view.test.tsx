// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@hyperfide/plugin-sdk/testing/app";
import definition from "../../app.js";
import fixture from "./__fixtures__/ledger.json";
import {
  fleetRpcContract,
  ledgerSchema,
  stages,
  type FleetLedger,
} from "./contract.js";
import { createFleetHandlers, type FleetBackend } from "./rpc.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
afterEach(cleanup);

function backend() {
  const ledger = ledgerSchema.parse(structuredClone(fixture));
  const readLedger = vi.fn(async () => ledger);
  const handlers: FleetBackend = {
    readLedger,
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
  return { ledger, handlers, readLedger, rpc: createFleetHandlers(handlers) };
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
    for (const stage of fixture.timelines[0].events.map((event) => event.stage))
      expect(slot.getByText(`${stage}: 2026-10-23T10:00:00Z`)).toBeTruthy();
    expect(slot.getByLabelText("Log job-1").textContent).toContain(
      "<script>fixture</script>",
    );
    expect(slot.container.querySelector("script")).toBeNull();
  });

  it("keeps fleet landmarks and data tables reachable at narrow viewport widths", async () => {
    const { slot } = await mount();
    for (const label of [
      "Authority",
      "Budget",
      "Machines",
      "Jobs",
      "Task timelines",
    ]) {
      expect(slot.getByRole("region", { name: label })).toBeTruthy();
    }
    for (const label of ["Machines", "Jobs"]) {
      const region = slot.getByRole("region", { name: label });
      expect(region.className).toContain("overflow-x-auto");
      expect(within(region).getByRole("table")).toBeTruthy();
    }
    expect(slot.getByRole("button", { name: "Pause dispatch" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Cancel job-1" })).toBeTruthy();
  });

  it("refreshes the ledger and restores causal freshness after WebView reconnect", async () => {
    const source = backend();
    const { slot } = await mount(source);
    source.readLedger.mockClear();
    await slot.setRealtimeConnectionState("reconnecting");
    expect(
      slot.getByRole("status", { name: "Fleet freshness" }).textContent,
    ).toContain("unknown until the connection recovers");
    await slot.setRealtimeConnectionState("connected");
    await waitFor(() => expect(source.readLedger).toHaveBeenCalledTimes(1));
    expect(
      slot.getByRole("status", { name: "Fleet freshness" }).textContent,
    ).toContain("Causal freshness as of");
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

  it("renders manager-directed ledgers without legacy mutation controls", async () => {
    const source = backend();
    source.ledger.authority = {
      mode: "manager",
      state: "WAITING_FOR_MANAGER",
      actorRole: "FEATURE_MANAGER",
      capabilities: ["read", "manager-decision"],
      authorityEpoch: "authority-epoch",
      leaderGeneration: "leader-generation",
      delegationId: "delegation",
      managerGeneration: "manager-generation",
      asOf: "2026-10-23T10:00:00.000Z",
    };
    source.handlers.readAuthoritativeLedger = vi.fn(async () => ({
      authority: source.ledger.authority,
      history: [
        {
          decisionId: "decision-manager",
          operationId: "operation-manager",
          actorId: "manager-1",
          actorRole: "WAVE_MANAGER",
          action: "PROVISION_SANDBOX",
          authorityEpoch: "authority-epoch",
          leaderGeneration: "leader-generation",
          delegationId: "delegation",
          managerGeneration: "manager-generation",
          receiptState: "UNKNOWN",
          receiptDigest: "sha256:" + "b".repeat(64),
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
    }));
    const { slot } = await mount(source);
    expect(
      slot.getByRole("region", { name: "Authority" }).textContent,
    ).toContain("FEATURE_MANAGER");
    expect(
      slot.getByText(/Manager-directed dispatch is read-only/),
    ).toBeTruthy();
    expect(
      slot.getByRole("region", { name: "Authority" }).textContent,
    ).toContain("Leader generation: leader-generation");
    expect(
      slot.getByRole("region", { name: "Authority" }).textContent,
    ).toContain("Manager generation: manager-generation");
    expect(slot.queryByRole("button", { name: "Pause dispatch" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Resume dispatch" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Raise cap" })).toBeNull();
    expect(slot.queryByLabelText("Cap")).toBeNull();
    expect(slot.queryByRole("button", { name: "Cancel job-1" })).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Destroy machine-1" }),
    ).toBeNull();
    const history = slot.getByRole("region", { name: "Authoritative history" });
    expect(history.textContent).toContain("PROVISION_SANDBOX");
    expect(history.textContent).toContain("WAVE_MANAGER: manager-1");
    expect(history.textContent).toContain("UNKNOWN");
    expect(
      slot.getByRole("alert", { name: "Fleet outcome warning" }).textContent,
    ).toContain("UNKNOWN or OUTCOME_UNKNOWN");
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
    const read = vi.fn(source.rpc.fleetLedger);
    const slot = renderSlot<{ subPath: string }, typeof fleetRpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: { ...source.rpc, fleetLedger: read },
        experimental_rpcContract: fleetRpcContract,
      },
    );
    await waitFor(() =>
      expect(slot.getByRole("region", { name: "Budget" })).toBeTruthy(),
    );
    read.mockRejectedValueOnce(new Error("ledger unavailable"));
    await slot.setRealtimeConnectionState("reconnecting");
    await slot.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toContain(
        "ledger unavailable",
      ),
    );
    expect(
      slot.getByRole("status", { name: "Fleet freshness" }).textContent,
    ).toContain("STALE");
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

  it("coalesces overlapping realtime refreshes into one in-flight read", async () => {
    const source = backend();
    const { slot } = await mount(source);
    let release!: (value: FleetLedger) => void;
    let activeReads = 0;
    let maximumActiveReads = 0;
    const readLedger = vi.fn(
      () =>
        new Promise<FleetLedger>((resolve) => {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          release = (value) => {
            activeReads -= 1;
            resolve(value);
          };
        }),
    );
    source.handlers.readLedger = readLedger;
    await Promise.all([
      slot.behavior.emitRealtime("fleet:changed", {}),
      slot.behavior.emitRealtime("fleet:changed", {}),
    ]);
    expect(readLedger).toHaveBeenCalledTimes(1);
    expect(maximumActiveReads).toBe(1);
    release(source.ledger);
    await waitFor(() => expect(readLedger).toHaveBeenCalledTimes(2));
    release(source.ledger);
    await waitFor(() => expect(activeReads).toBe(0));
  });
});

describe("Fleet RPC boundaries", () => {
  it("uses the authenticated control-plane projection for manager history", async () => {
    const source = backend();
    source.handlers.readAuthoritativeLedger = vi.fn(async () => ({
      authority: {
        ...source.ledger.authority,
        mode: "manager" as const,
        capabilities: [
          "read",
          "manager-decision",
        ] as FleetLedger["authority"]["capabilities"],
      },
      history: [
        {
          decisionId: "decision-1",
          operationId: "operation-1",
          actorId: "manager-1",
          actorRole: "WAVE_MANAGER",
          action: "PROVISION_SANDBOX",
          authorityEpoch: "epoch-1",
          leaderGeneration: "7",
          delegationId: "package-1",
          managerGeneration: "3",
          receiptState: "UNKNOWN",
          receiptDigest: "sha256:" + "a".repeat(64),
          createdAt: "2026-10-23T10:00:00.000Z",
        },
      ],
    }));
    const view = await source.rpc.fleetLedger();
    expect(source.handlers.readAuthoritativeLedger).toHaveBeenCalledOnce();
    expect(view.history[0]).toMatchObject({
      actorRole: "WAVE_MANAGER",
      delegationId: "package-1",
      receiptState: "UNKNOWN",
    });
  });

  it("rejects authoritative history that exceeds the bounded projection", async () => {
    const source = backend();
    source.handlers.readAuthoritativeLedger = vi.fn(async () => ({
      authority: source.ledger.authority,
      history: Array.from({ length: 501 }, (_, index) => ({
        decisionId: `decision-${index}`,
        operationId: `operation-${index}`,
        actorId: "manager-1",
        actorRole: "WAVE_MANAGER",
        action: "PROVISION_SANDBOX",
        authorityEpoch: null,
        leaderGeneration: null,
        delegationId: null,
        managerGeneration: null,
        receiptState: null,
        receiptDigest: null,
        createdAt: "2026-10-23T10:00:00.000Z",
      })),
    }));
    await expect(source.rpc.fleetLedger()).rejects.toThrow();
  });

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
