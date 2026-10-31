// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HyperfideDesktopServerChoice } from "@hyperfide/desktop-contract";
import { createHyperfideDesktopApi } from "../test/hyperfide-desktop-test-utils";
import { getServerChoices } from "./server-choices";
import { useServerChoices } from "../hooks/useServerChoices";

function createDesktopApi() {
  return createHyperfideDesktopApi({
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: "macos",
    updateAvailable: false,
    updateDownloaded: false,
    version: "test",
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "hyperfideDesktop");
});

describe("desktop server choices", () => {
  it.each(["browser", "older-desktop"])("omits switching on %s", (client) => {
    if (client === "older-desktop") window.hyperfideDesktop = createDesktopApi();
    expect(getServerChoices()).toBeNull();
  });

  it("keeps a newer subscription update when an older list response arrives", async () => {
    let resolveList: (choices: HyperfideDesktopServerChoice[]) => void = () => {
      throw new Error("List was not requested");
    };
    const listeners = new Set<(choices: HyperfideDesktopServerChoice[]) => void>();
    window.hyperfideDesktop = {
      ...createDesktopApi(),
      getServerChoices: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      onServerChoicesChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      selectServer: () => {},
    };
    const { result } = renderHook(useServerChoices);
    const newer = [{ id: "new", name: "New server", active: true }];
    await act(async () => {
      for (const listener of listeners) listener(newer);
      resolveList([]);
    });
    expect(result.current.choices).toEqual(newer);
  });
});
