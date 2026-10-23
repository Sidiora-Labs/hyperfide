// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/dom";
import { expect, it } from "vitest";
import { mountWaveClosure } from "../hyperfide-qualify/app";
import {
  makeHumanTasks,
  type WaveSnapshot,
} from "../hyperfide-spec/closure-projection";
import { closureView } from "../hyperfide-spec/wave-detail";

it("renders closure blockers and requires an operator action for each human job", async () => {
  const commit = "a".repeat(40);
  const wave: WaveSnapshot = {
    feature: "fixture",
    wave: 4,
    tasks: [
      {
        id: "4.4",
        title: "Closure",
        status: "done",
        commit,
        checker: { verdict: "pass", commit },
        lanes: [{ status: "passed", commit, closureCheck: "pass" }],
      },
    ],
    humans: makeHumanTasks(),
    asks: [],
  };
  const container = document.createElement("div");
  document.body.append(container);
  await mountWaveClosure(container, {
    read: async () => closureView(wave),
    mark: async (job) => {
      wave.humans.find((task) => task.id === job)!.mark = {
        operator: "owner",
        at: "2026-10-23",
      };
      return closureView(wave);
    },
  });
  expect(container.textContent).toContain("Closure blocked");
  expect(container.querySelectorAll("button")).toHaveLength(3);
  for (let remaining = 2; remaining >= 0; remaining--) {
    fireEvent.click(container.querySelector("button")!);
    await waitFor(() =>
      expect(container.querySelectorAll("button")).toHaveLength(remaining),
    );
  }
  expect(container.textContent).toContain("Ready to publish");
  expect(container.textContent).toContain("marked by owner");
  container.remove();
});
