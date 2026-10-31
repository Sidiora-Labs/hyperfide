import { ipcMain, type BrowserWindow } from "electron";
import { escapeHtmlText } from "@hyperfide/text-utils";
import { createDesktopDialogWindow, DESKTOP_DIALOG_BASE_CSS, showDesktopDialogHtml } from "./desktop-dialog-window.js";
import { CREDENTIALS_CANCEL, CREDENTIALS_SUBMIT, credentialsRequestSchema, type CredentialsRequest } from "./server-credentials-dialog-ipc.js";
export function openServerCredentialsDialog(args: { origin: string; parentWindow: BrowserWindow | null; preloadPath: string; canRemember: boolean }): Promise<CredentialsRequest | null> {
  const window = createDesktopDialogWindow({ ...args, title: "Server sign in", width: 440 });
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: CredentialsRequest | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(CREDENTIALS_SUBMIT, submit);
      ipcMain.removeListener(CREDENTIALS_CANCEL, cancel);
      if (!window.isDestroyed()) window.close();
      resolve(value);
    };
    const submit = (event: { sender: { id: number } }, payload: unknown) => {
      if (event.sender.id !== window.webContents.id) return;
      const parsed = credentialsRequestSchema.safeParse(payload);
      if (parsed.success) finish(parsed.data);
    };
    const cancel = (event: { sender: { id: number } }) => { if (event.sender.id === window.webContents.id) finish(null); };
    ipcMain.on(CREDENTIALS_SUBMIT, submit);
    ipcMain.on(CREDENTIALS_CANCEL, cancel);
    window.on("closed", () => finish(null));
    showDesktopDialogHtml(window, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${DESKTOP_DIALOG_BASE_CSS} label {display:block;margin:12px 0} input:not([type=checkbox]) {display:block;width:95%}</style></head><body><h1>This server asks for a username and password</h1><p>${escapeHtmlText(args.origin)}</p><form data-credentials><label>Username<input name="username" required pattern="[^:]+" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><label><input name="remember" type="checkbox" ${args.canRemember ? "" : "disabled"}>Remember on this computer</label>${args.canRemember ? "" : "<p>Secure storage is unavailable. Credentials last for this session only.</p>"}<button type="button" data-cancel>Cancel</button><button type="submit">Sign in</button></form></body></html>`);
  });
}
