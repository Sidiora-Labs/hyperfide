import { hyperfideDesktopClipboardContentSchema } from "@hyperfide/desktop-contract";
import { clipboard, ClipboardItem, ipcMain } from "electron";
import { HYPERFIDE_DESKTOP_WRITE_CLIPBOARD_CHANNEL } from "./desktop-window-command-ipc.js";
import type { DesktopIpcAuthorizer } from "./desktop-ipc-authorization.js";

export function registerDesktopClipboardIpc(
  applicationWindowWebContentsIds: ReadonlySet<number>,
  isAuthorized: DesktopIpcAuthorizer = (event) =>
    event.senderFrame === undefined ||
    event.senderFrame === event.sender.mainFrame,
): void {
  ipcMain.handle(
    HYPERFIDE_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
    async (event, payload: unknown) => {
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        !isAuthorized(event)
      ) {
        throw new Error("Clipboard writes are limited to hyperfide windows");
      }
      const { text, html } =
        hyperfideDesktopClipboardContentSchema.parse(payload);
      if (html === undefined) {
        await clipboard.writeText(text);
        return;
      }
      await clipboard.write([
        new ClipboardItem({ "text/plain": text, "text/html": html }),
      ]);
    },
  );
}
