import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerServerChoiceIpc } from "../src/server-choice-ipc.js";
import {
  HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL,
} from "../src/desktop-window-command-ipc.js";

const ipc = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: ipc }));

const frame = {};
const event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame };

beforeEach(() => vi.clearAllMocks());

describe("server choice IPC", () => {

  it("accepts only inactive native choices from the application main frame", async () => {
    const select = vi.fn(async () => undefined);
    const onError = vi.fn();
    registerServerChoiceIpc({
      applicationWindowWebContentsIds: new Set([7]),
      list: () => [
        { id: "builtin", name: "Local", active: true },
        { id: "remote", name: "Remote", active: false },
      ],
      select,
      onError,
    });
    const request = ipc.on.mock.calls.find(
      ([channel]) => channel === HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL,
    )?.[1];
    if (!request) throw new Error("Missing select handler");
    for (const id of ["builtin", "unknown", "https://injected.example", {}, ""])
      request(event, id);
    request({ ...event, senderFrame: {} }, "remote");
    request({ ...event, sender: { id: 99, mainFrame: frame } }, "remote");
    expect(select).not.toHaveBeenCalled();
    request(event, "remote");
    expect(select).toHaveBeenCalledWith("remote");
    select.mockRejectedValueOnce(new Error("disk full"));
    request(event, "remote");
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "disk full" }),
    );
  });
});
