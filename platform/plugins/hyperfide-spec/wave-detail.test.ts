import { describe, expect, it } from "vitest";
import { makeHumanTasks, type WaveSnapshot } from "./wave-authority";
import { closureView, waveDetail } from "./wave-detail";

export function readyWave(): WaveSnapshot {
  return {
    feature: "fixture",
    wave: 4,
    tasks: [
      {
        id: "4.1",
        title: "First task",
        status: "done",
        commit: "a".repeat(40),
        checker: { verdict: "pass", commit: "a".repeat(40) },
        lanes: [
          { status: "passed", commit: "a".repeat(40), closureCheck: "pass" },
        ],
      },
    ],
    humans: makeHumanTasks().map((task) => ({
      ...task,
      mark: { operator: "owner", at: "2026-10-23T00:00:00Z" },
    })),
    asks: [],
  };
}
describe("wave closure", () => {
  it("closes only a proven wave", () =>
    expect(closureView(readyWave()).ready).toBe(true));
  it.each([
    [
      "unfinished task",
      (w: WaveSnapshot) => {
        w.tasks[0].status = "implemented";
      },
    ],
    [
      "checker findings",
      (w: WaveSnapshot) => {
        w.tasks[0].checker.verdict = "findings";
      },
    ],
    [
      "stale checker",
      (w: WaveSnapshot) => {
        w.tasks[0].checker.commit = "old";
      },
    ],
    [
      "failed lane",
      (w: WaveSnapshot) => {
        w.tasks[0].lanes[0].status = "failed";
      },
    ],
    [
      "running lane",
      (w: WaveSnapshot) => {
        w.tasks[0].lanes[0].status = "running";
      },
    ],
    [
      "missing lane",
      (w: WaveSnapshot) => {
        w.tasks[0].lanes = [];
      },
    ],
    [
      "stale lane",
      (w: WaveSnapshot) => {
        w.tasks[0].lanes[0].commit = "old";
      },
    ],
    [
      "closure check failure",
      (w: WaveSnapshot) => {
        w.tasks[0].lanes[0].closureCheck = "fail";
      },
    ],
    [
      "open Ask",
      (w: WaveSnapshot) => {
        w.asks.push({ id: "ask", status: "open" });
      },
    ],
    [
      "missing human task",
      (w: WaveSnapshot) => {
        w.humans.pop();
      },
    ],
    [
      "unmarked human task",
      (w: WaveSnapshot) => {
        delete w.humans[0].mark;
      },
    ],
    [
      "empty wave",
      (w: WaveSnapshot) => {
        w.tasks = [];
      },
    ],
  ])("blocks %s", (_name, mutate) => {
    const wave = readyWave();
    mutate(wave);
    expect(closureView(wave).ready).toBe(false);
  });
  it("requires each human job to be marked through an operator action", async () => {
    const wave = readyWave();
    wave.humans = makeHumanTasks();
    const detail = waveDetail({
      read: async () => wave,
      mark: async (_f, _w, job, operator) => {
        wave.humans.find((task) => task.id === job)!.mark = {
          operator: operator.id,
          at: new Date().toISOString(),
        };
      },
    });
    expect((await detail.read("fixture", 4)).ready).toBe(false);
    await expect(
      detail.mark("fixture", 4, "judge-output", {
        id: "agent",
        role: "worker",
      } as never),
    ).rejects.toThrow("Operator");
    for (const task of wave.humans)
      await detail.mark("fixture", 4, task.id, {
        id: "owner",
        role: "operator",
      });
    expect((await detail.read("fixture", 4)).ready).toBe(true);
  });
});
