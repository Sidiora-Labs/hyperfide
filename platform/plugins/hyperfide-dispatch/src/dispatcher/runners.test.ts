import { describe, expect, it } from "vitest";
import { fleetRunners, imageRunnerKinds, isFleetRunnerKind } from "./runners.js";

describe("fleet image runner kinds", () => {
  it("derives legacy image capabilities from registered CLI probes", () => {
    const runner = fleetRunners[0];
    expect(imageRunnerKinds({ base: { steps: [["tools", runner.probe, 300]] } })).toEqual([runner.kind]);
    expect(imageRunnerKinds({ base: { steps: [] } })).toEqual([]);
  });
  it("validates explicit image runner kinds against the provider registry", () => {
    expect(imageRunnerKinds({ runnerKinds: fleetRunners.map(runner => runner.kind) })).toEqual(fleetRunners.map(runner => runner.kind));
    expect(isFleetRunnerKind("unregistered-runner")).toBe(false);
    expect(() => imageRunnerKinds({ runnerKinds: ["unregistered-runner"] })).toThrow("Unknown image runner kind");
  });
});
