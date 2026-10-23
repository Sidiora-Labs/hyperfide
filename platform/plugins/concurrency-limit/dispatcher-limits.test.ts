import { expect, it } from "vitest";
import { dispatcherLimits } from "./dispatcher-limits";
it("exposes global, automatic and override budgets including zero", () => {
  expect(
    dispatcherLimits({ globalLimit: 3, hostOverrides: [] }, "host", 4, 2),
  ).toEqual({ global: 3, host: 4, otherRunning: 2 });
  expect(
    dispatcherLimits(
      { globalLimit: 0, hostOverrides: [{ hostId: "host", limit: 0 }] },
      "host",
      4,
      0,
    ),
  ).toEqual({ global: 0, host: 0, otherRunning: 0 });
});
