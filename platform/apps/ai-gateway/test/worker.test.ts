import { expect, it, vi } from "vitest";
import worker from "../src/worker.js";

it("refuses hosted requests without contacting an account service", async () => {
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  try {
    const response = await worker.fetch();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Hosted accounts are disabled",
    });
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
