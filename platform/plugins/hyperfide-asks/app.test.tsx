// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { installTestPluginRuntime } from "@hyperfide/plugin-sdk/testing/app";
import { InboxView } from "./app.js";
import type { Ask } from "./src/inbox-adapter.js";

installTestPluginRuntime();

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const ask =(kind: Ask["kind"], id = 1): Ask => ({
  id,
  kind,
  repository: "repo",
  task: "3.3",
  question: `Need ${kind}`,
  options: [],
  recommendation: "",
  status: "open",
  deadline: Date.now() / 1000 + 120,
});

const openFilters = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Filters/ }));
const toggleFilter = (name: RegExp | string) =>
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name }));
const openAnswer = () =>
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));

afterEach(cleanup);

it("shows kind, scope, deadline and recommendation for open asks only", () => {
  render(
    <InboxView
      asks={[
        { ...ask("decision"), options: ["a", "b"], recommendation: "a" },
        { ...ask("secret", 2), repository: "other", task: "3.1" },
        { ...ask("question", 3), status: "answered" },
      ]}
      answer={vi.fn()}
    />,
  );
  expect(screen.getByText("Recommended: a").className).toContain(
    "font-medium",
  );
  expect(screen.getAllByText(/m remaining/)).toHaveLength(2);
  expect(screen.getByText("other / 3.1")).toBeTruthy();
  expect(screen.getByText("2 options")).toBeTruthy();
  expect(screen.queryByText("Need question")).toBeNull();
});

it("filters by kind and task through the filter menu", () => {
  render(
    <InboxView
      asks={[
        { ...ask("decision"), options: ["a", "b"], recommendation: "a" },
        { ...ask("secret", 2), repository: "other", task: "3.1" },
      ]}
      answer={vi.fn()}
    />,
  );
  openFilters();
  toggleFilter(/^Secret/);
  expect(screen.queryByText("Need decision")).toBeNull();
  expect(screen.getByText("Need secret")).toBeTruthy();
  toggleFilter("3.3");
  expect(screen.queryByText("Need secret")).toBeNull();
  expect(screen.getByText("No asks match these filters.")).toBeTruthy();
});

it("searches across question, scope and options", () => {
  render(
    <InboxView
      asks={[
        { ...ask("decision"), options: ["alpha", "beta"], recommendation: "" },
        { ...ask("secret", 2), repository: "other", task: "3.1" },
      ]}
      answer={vi.fn()}
    />,
  );
  const search = screen.getByPlaceholderText("Search asks");
  fireEvent.change(search, { target: { value: "beta" } });
  expect(screen.getByText("Need decision")).toBeTruthy();
  expect(screen.queryByText("Need secret")).toBeNull();
  fireEvent.change(search, { target: { value: "other" } });
  expect(screen.queryByText("Need decision")).toBeNull();
  expect(screen.getByText("Need secret")).toBeTruthy();
  fireEvent.change(search, { target: { value: "nothing" } });
  expect(screen.getByText('No asks match "nothing"')).toBeTruthy();
});

it("renders error, retry, empty and refresh-failure states", () => {
  const retry = vi.fn();
  const { rerender } = render(
    <InboxView asks={null} error="boom" onRetry={retry} answer={vi.fn()} />,
  );
  expect(screen.getByText("Inbox could not be loaded.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
  rerender(<InboxView asks={[]} answer={vi.fn()} />);
  expect(screen.getByText(/No open asks/)).toBeTruthy();
  rerender(
    <InboxView asks={[ask("question")]} error="boom" answer={vi.fn()} />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Inbox could not be refreshed",
  );
  expect(screen.getByText("Need question")).toBeTruthy();
});

it("masks secret answers until revealed and keeps no note", () => {
  render(<InboxView asks={[ask("secret")]} answer={vi.fn()} />);
  openAnswer();
  const input = screen.getByLabelText("Answer value");
  expect(input.getAttribute("type")).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Show answer" }));
  expect(input.getAttribute("type")).toBe("text");
  expect(screen.queryByLabelText("Note")).toBeNull();
});

it("requires a choice and an operator identity before granting a permission", () => {
  const answer = vi.fn().mockResolvedValue({});
  render(<InboxView asks={[ask("permission")]} answer={answer} />);
  openAnswer();
  fireEvent.click(screen.getByText("Submit answer"));
  expect(screen.getByRole("alert").textContent).toBe(
    "Choose whether to grant or refuse.",
  );
  fireEvent.click(screen.getByLabelText("Grant"));
  fireEvent.click(screen.getByText("Submit answer"));
  expect(screen.getByRole("alert").textContent).toBe(
    "Your operator identity is required to answer a permission.",
  );
  expect(answer).not.toHaveBeenCalled();
});

it("reports a failed answer and keeps the dialog open", async () => {
  const answer = vi.fn().mockRejectedValue(new Error("nope"));
  render(<InboxView asks={[ask("question")]} answer={answer} />);
  openAnswer();
  fireEvent.change(screen.getByLabelText("Answer value"), {
    target: { value: "response" },
  });
  fireEvent.click(screen.getByText("Submit answer"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "Answer could not be saved. Please retry.",
    ),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

for (const kind of [
  "secret",
  "variable",
  "permission",
  "decision",
  "question",
] as const) {
  it(`answers ${kind} through the dialog`, async () => {
    const answer = vi.fn().mockResolvedValue({});
    const row = {
      ...ask(kind),
      ...(kind === "decision"
        ? { options: ["a", "b"], recommendation: "a" }
        : {}),
    };
    render(<InboxView asks={[row]} answer={answer} />);
    openAnswer();
    if (kind === "permission") {
      fireEvent.click(screen.getByLabelText("Refuse"));
      fireEvent.change(screen.getByLabelText("Operator identity"), {
        target: { value: "operator" },
      });
    } else if (kind === "decision") {
      expect(
        screen.getByLabelText("a (recommended)").getAttribute("aria-checked"),
      ).toBe("true");
      fireEvent.click(screen.getByLabelText("b"));
    } else {
      if (kind === "variable")
        fireEvent.click(screen.getByLabelText("Sensitive"));
      const input = screen.getByLabelText("Answer value");
      if (kind === "secret" || kind === "variable")
        expect(input.getAttribute("type")).toBe("password");
      fireEvent.change(input, { target: { value: "response" } });
    }
    fireEvent.click(screen.getByText("Submit answer"));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    expect(answer.mock.calls[0]![0]).toMatchObject({
      repository: "repo",
      id: 1,
      sensitive: kind === "variable",
      value:
        kind === "permission"
          ? "reject"
          : kind === "decision"
            ? "b"
            : "response",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
}
