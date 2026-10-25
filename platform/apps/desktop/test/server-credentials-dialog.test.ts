import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({ create: vi.fn(), show: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { on: mocks.on, removeListener: mocks.remove } }));
vi.mock("../src/desktop-dialog-window.js", () => ({
  createDesktopDialogWindow: mocks.create, showDesktopDialogHtml: mocks.show, DESKTOP_DIALOG_BASE_CSS: "",
}));
import { openServerCredentialsDialog } from "../src/server-credentials-dialog.js";
import { CREDENTIALS_SUBMIT, CREDENTIALS_CANCEL } from "../src/server-credentials-dialog-ipc.js";
afterEach(() => vi.clearAllMocks());
function setup() {
  const events = new EventEmitter();
  const window = { webContents: { id: 42 }, isDestroyed: () => false, close: vi.fn(() => events.emit("closed")), on: events.on.bind(events) };
  mocks.create.mockReturnValue(window);
  const result = openServerCredentialsDialog({ origin: "https://server.example", canRemember: false, parentWindow: null, preloadPath: "server-url-dialog-preload.cjs" });
  const handler = (channel: string) => mocks.on.mock.calls.find(call => call[0] === channel)![1] as (event: { sender: { id: number } }, payload?: unknown) => void;
  return { window, result, handler };
}
it("uses a small isolated modal with a masked password and session-only explanation", async () => {
  const { handler, result } = setup();
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ width: 440, title: "Server sign in" }));
  const html = mocks.show.mock.calls[0]![1] as string;
  expect(html).toContain('type="password"');
  expect(html).toContain("disabled");
  expect(html).toContain("this session only");
  handler(CREDENTIALS_CANCEL)({ sender: { id: 42 } });
  expect(await result).toBeNull();
});
it("ignores other senders and malformed IPC, accepts typed credentials, and cleans up", async () => {
  const { result, handler, window } = setup();
  handler(CREDENTIALS_SUBMIT)({ sender: { id: 99 } }, { username: "u", password: "p", remember: true });
  handler(CREDENTIALS_SUBMIT)({ sender: { id: 42 } }, { password: "p" });
  expect(window.close).not.toHaveBeenCalled();
  handler(CREDENTIALS_SUBMIT)({ sender: { id: 42 } }, { username: "u", password: "p", remember: false });
  expect(await result).toEqual({ username: "u", password: "p", remember: false });
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  expect(window.close).toHaveBeenCalledOnce();
});
it("closing the window cancels the sign-in", async () => {
  const { window, result } = setup(); window.close();
  expect(await result).toBeNull();
});
