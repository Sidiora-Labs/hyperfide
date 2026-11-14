import { BrowserWindow, ipcMain } from "electron";
import { HYPERFIDE_DESKTOP_FOCUS_WINDOW_CHANNEL } from "./desktop-window-command-ipc.js";
import type { DesktopIpcAuthorizer } from "./desktop-ipc-authorization.js";

export function registerDesktopWindowFocusIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
  isAuthorized: DesktopIpcAuthorizer = (event) =>
    event.senderFrame === undefined ||
    event.senderFrame === event.sender.mainFrame,
): void {
  ipcMain.on(HYPERFIDE_DESKTOP_FOCUS_WINDOW_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      !isAuthorized(event)
    )
      return;
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (browserWindow === null || browserWindow.isDestroyed()) return;
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.show();
    browserWindow.focus();
  });
}
