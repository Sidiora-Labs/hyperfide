import { expect, it, vi } from "vitest";
import { resolveServerMoveMode } from "../../src/services/server-move/mode.js";

it("uses direct server access without querying hosted plugins or the network", async () => {
  const plugins = {
    list: vi.fn(),
    getRpcHandler: vi.fn(),
    invokeRpcHandler: vi.fn(),
  };
  const network = vi.fn();
  vi.stubGlobal("fetch", network);
  try {
    expect(await resolveServerMoveMode({} as never, plugins)).toEqual({
      mode: "direct",
    });
    expect(plugins.list).not.toHaveBeenCalled();
    expect(plugins.getRpcHandler).not.toHaveBeenCalled();
    expect(plugins.invokeRpcHandler).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
