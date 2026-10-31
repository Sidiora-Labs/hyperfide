// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { installTestPluginRuntime } from "@hyperfide/plugin-sdk/testing/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import type { Ask } from "../src/inbox-adapter.js";
import { AskRow, remainingLabel } from "./ask-row.js";

installTestPluginRuntime();

const now = Date.parse("2026-10-24T12:00:00Z");
const ask: Ask = {
  id: 4,
  kind: "variable",
  repository: "repo",
  task: "7.10",
  question: "Which endpoint serves the index?",
  options: [],
  recommendation: "",
  status: "open",
  deadline: now / 1000 + 6 * 86400 + 15 * 3600 + 20 * 60,
};

afterEach(cleanup);

it("humanises the remaining time into days, hours and minutes", () => {
  expect(remainingLabel(null, now)).toBe("No deadline");
  expect(remainingLabel("not a date", now)).toBe("No deadline");
  expect(remainingLabel(now / 1000 - 1, now)).toBe("Overdue");
  expect(remainingLabel(now / 1000 + 90, now)).toBe("2m remaining");
  expect(remainingLabel(now / 1000 + 3 * 3600 + 5 * 60, now)).toBe(
    "3h 5m remaining",
  );
  expect(remainingLabel(ask.deadline, now)).toBe("6d 15h remaining");
  expect(remainingLabel(new Date(now + 2 * 86400000).toISOString(), now)).toBe(
    "2d 0h remaining",
  );
});

it("keeps scope and deadline beside the title on wide viewports", () => {
  render(<AskRow ask={ask} now={now} onAnswer={vi.fn()} />);
  const title = screen.getByRole("button", {
    name: /Which endpoint serves the index\?/,
  });
  expect(title.textContent).toContain("repo / 7.10");
  expect(title.textContent).not.toContain("remaining");
  expect(screen.getByText("6d 15h remaining")).toBeTruthy();
});

it("folds scope and deadline into the description on compact viewports", () => {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <AskRow ask={ask} now={now} onAnswer={vi.fn()} />
    </CompactViewportOverrideProvider>,
  );
  const title = screen.getByRole("button", {
    name: /Which endpoint serves the index\?/,
  });
  expect(title.textContent).not.toContain("repo / 7.10");
  expect(screen.getByText("repo / 7.10")).toBeTruthy();
  expect(screen.getByText("6d 15h remaining")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Answer" })).toBeTruthy();
});
