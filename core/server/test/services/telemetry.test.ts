import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryService,
  runWithTelemetryAppSurface,
} from "../../src/services/system/telemetry.js";

afterEach(() => vi.unstubAllGlobals());

describe("local event logging", () => {
  it("logs events at debug level without making network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const events = await createTelemetryService({ logger });
    const event = { name: "app_started" } as const;
    events.capture(event);
    expect(logger.debug).toHaveBeenCalledWith(
      { event, appSurface: undefined },
      "Local event",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps request context isolated across concurrent local events", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const events = await createTelemetryService({ logger });
    await Promise.all(
      ["desktop", "web"].map(
        async (surface) =>
          await runWithTelemetryAppSurface(
            surface as "desktop" | "web",
            async () => {
              await Promise.resolve();
              events.capture({ name: "app_started" });
            },
          ),
      ),
    );
    expect(
      logger.debug.mock.calls.map(([data]) => data.appSurface).sort(),
    ).toEqual(["desktop", "web"]);
  });
});
