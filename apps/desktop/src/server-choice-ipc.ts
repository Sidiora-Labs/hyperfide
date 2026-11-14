import {
  hyperfideDesktopServerChoiceSchema,
  type HyperfideDesktopServerChoice,
} from "@hyperfide/desktop-contract";
import { ipcMain } from "electron";
import {
  HYPERFIDE_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL,
} from "./desktop-window-command-ipc.js";
import type { DesktopIpcAuthorizer } from "./desktop-ipc-authorization.js";

export function registerServerChoiceIpc({
  applicationWindowWebContentsIds,
  isAuthorized,
  list,
  select,
  onError,
}: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  isAuthorized?: DesktopIpcAuthorizer;
  list(): HyperfideDesktopServerChoice[];
  select(id: string): Promise<void>;
  onError(error: unknown): void;
}): void {
  const authorize =
    isAuthorized ??
    ((event) =>
      event.senderFrame === undefined ||
      event.senderFrame === event.sender.mainFrame);
  ipcMain.handle(HYPERFIDE_DESKTOP_GET_SERVER_CHOICES_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      !authorize(event)
    ) {
      throw new Error("Server choices are limited to hyperfide windows");
    }
    return list();
  });
  ipcMain.on(
    HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL,
    (event, payload: unknown) => {
      const parsed =
        hyperfideDesktopServerChoiceSchema.shape.id.safeParse(payload);
      if (
        !applicationWindowWebContentsIds.has(event.sender.id) ||
        !authorize(event) ||
        !parsed.success
      )
        return;
      if (!list().some((choice) => choice.id === parsed.data && !choice.active))
        return;
      void select(parsed.data).catch(onError);
    },
  );
}
