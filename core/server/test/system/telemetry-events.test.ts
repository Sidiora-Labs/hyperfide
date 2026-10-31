import { describe, expect, it, vi } from "vitest";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function post(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/system/telemetry/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("retired event reporting endpoint", () => {
  it.each([
    {
      name: "onboarding_step_skipped",
      properties: { step: "projects", entry: "first_run" },
    },
    { name: "unknown_event" },
    {
      name: "onboarding_step_skipped",
      properties: { email: "user@example.test" },
    },
  ])("does not accept or capture client events: %j", async (event) => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn();
      harness.deps.telemetry = { ...harness.deps.telemetry, capture };
      const response = await post(harness, event);
      expect(response.status).toBe(404);
      expect(capture).not.toHaveBeenCalled();
    });
  });
});
