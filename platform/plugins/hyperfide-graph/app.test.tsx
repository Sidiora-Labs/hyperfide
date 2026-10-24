// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "@hyperfide/plugin-sdk/testing/app";
import type { PluginNavPanelProps } from "@hyperfide/plugin-sdk/app";
import { IndexView, SurveyViewer } from "./app.js";
import { graphRpcContract, type GraphResult } from "./contract.js";

installTestPluginRuntime();

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

const binary = {
  path: "/cg",
  version: "Hyperfide 22",
  digest: "a".repeat(64),
  ok: true as const,
};
const indexResult: GraphResult = {
  binary,
  data: {
    status: "ready",
    last_pass: "2026-10-23",
    symbols: 42,
    files: 12,
    stale_anchors: 3,
  },
};

it("registers the Index panel", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  expect(app.navPanels[0]).toMatchObject({
    id: "hyperfide-graph",
    title: "Index",
  });
});

it("shows index and binary freshness and survey output", () => {
  const { container, unmount } = render(<IndexView result={indexResult} />);
  for (const label of [
    "Hyperfide 22",
    "aaaaaaaaaaaa",
    "ready",
    "2026-10-23",
    "42",
    "12",
    "Stale anchors",
    "3",
  ])
    expect(container.textContent).toContain(label);
  unmount();
  const survey = render(
    <SurveyViewer
      data={{ area: "src", symbols: ["entry"] }}
      binary={binary}
      target="src"
    />,
  );
  expect(survey.container.textContent).toContain("entry");
  expect(survey.container.textContent).toContain("2 fields");
  expect(survey.container.textContent).toContain("Hyperfide 22");
});

it("reads the scope, refreshes the index, surveys and saves settings", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  const settingsWrites: unknown[] = [];
  const slot = renderSlot<PluginNavPanelProps, typeof graphRpcContract>(
    app.navPanels[0]!,
    { subPath: "" },
    {
      experimental_rpcContract: graphRpcContract,
      rpc: {
        getSettings: () => ({ enabled: true, binaryPath: "/opt/cg" }),
        languageServerStatus: () => "running" as const,
        run: (input) =>
          input.command === "survey"
            ? { binary, data: { area: input.target, symbols: ["entry"] } }
            : indexResult,
        setSettings: (input) => {
          settingsWrites.push(input.settings);
          return input.settings;
        },
      },
    },
  );
  expect(
    screen.getByText("Enter a host and a repository to read its index."),
  ).toBeTruthy();
  const refresh = screen.getByRole("button", { name: "Refresh index" });
  expect(refresh.hasAttribute("disabled")).toBe(true);

  fireEvent.change(screen.getByLabelText("Host"), {
    target: { value: "host-1" },
  });
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "/repo" },
  });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Binary path override") as HTMLInputElement)
        .value,
    ).toBe("/opt/cg"),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Language server status" })
        .textContent,
    ).toContain("running"),
  );

  fireEvent.click(screen.getByRole("button", { name: "Refresh index" }));
  await waitFor(() => expect(screen.getByText("ready")).toBeTruthy());
  expect(slot.rpcCalls).toContainEqual({
    method: "run",
    input: { hostId: "host-1", repository: "/repo", command: "index-status" },
  });

  fireEvent.change(screen.getByLabelText("Area"), {
    target: { value: "src" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Survey" }));
  await waitFor(() => expect(slot.container.textContent).toContain("entry"));
  expect(slot.rpcCalls).toContainEqual({
    method: "run",
    input: {
      hostId: "host-1",
      repository: "/repo",
      command: "survey",
      target: "src",
    },
  });

  fireEvent.click(screen.getByRole("switch", { name: "Enable for repository" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(settingsWrites).toEqual([{ enabled: false, binaryPath: "/opt/cg" }]),
  );
  expect(await screen.findByText("Saved")).toBeTruthy();
});

it("surfaces a failing query as an alert", async () => {
  const app = await loadPluginApp(() => import("./app.js"));
  renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        getSettings: () => ({ enabled: true }),
        languageServerStatus: () => "stopped",
        run: () => {
          throw new Error("binary missing on host");
        },
      },
    },
  );
  fireEvent.change(screen.getByLabelText("Host"), {
    target: { value: "host-1" },
  });
  fireEvent.change(screen.getByLabelText("Repository"), {
    target: { value: "/repo" },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh index" }).hasAttribute(
        "disabled",
      ),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh index" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("binary missing on host");
  expect(
    screen.getByText("Refresh to read the index status from the host."),
  ).toBeTruthy();
});
