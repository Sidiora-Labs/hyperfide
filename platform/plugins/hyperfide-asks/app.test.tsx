// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { InboxView } from "./app.js";
import type { Ask } from "./src/bridge-projection.js";
const ask = (kind: Ask["kind"], id = 1): Ask => ({
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
afterEach(cleanup);
it("shows kind, task, deadline, recommendation and filters across repositories", () => {
  render(
    <InboxView
      asks={[
        { ...ask("decision"), options: ["a", "b"], recommendation: "a" },
        { ...ask("secret", 2), repository: "other", task: "3.1" },
      ]}
      answer={vi.fn()}
    />,
  );
  expect(screen.getByText("Recommended: a").className).toContain(
    "font-semibold",
  );
  expect(screen.getAllByText(/m remaining/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Kind"), {
    target: { value: "secret" },
  });
  expect(screen.queryByText("Need decision")).toBeNull();
  expect(screen.getByText("other / 3.1")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Task"), { target: { value: "3.3" } });
  expect(screen.queryByText("Need secret")).toBeNull();
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
    fireEvent.click(screen.getByText("Answer"));
    if (kind === "permission") {
      fireEvent.change(screen.getByLabelText("Permission"), {
        target: { value: "reject" },
      });
      fireEvent.change(screen.getByLabelText("Operator identity"), {
        target: { value: "operator" },
      });
    } else if (kind === "decision") {
      expect(
        (screen.getByLabelText("a (recommended)") as HTMLInputElement).checked,
      ).toBe(true);
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
