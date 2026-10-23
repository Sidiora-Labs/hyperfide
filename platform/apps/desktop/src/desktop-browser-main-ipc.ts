import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import type { z } from "zod";
import {
  bbDesktopBrowserAttachRequestSchema,
  bbDesktopBrowserEvaluateRequestSchema,
  bbDesktopBrowserFindInPageRequestSchema,
  bbDesktopBrowserNavigateRequestSchema,
  bbDesktopBrowserSetBoundsRequestSchema,
  bbDesktopBrowserSetThreadDiscardedRequestSchema,
  bbDesktopBrowserSetVisibleRequestSchema,
  bbDesktopBrowserStopFindInPageRequestSchema,
  bbDesktopBrowserTabRefSchema,
  type BbDesktopBrowserEvaluateResult,
} from "@bb/desktop-contract";
import {
  HYPERFIDE_DESKTOP_BROWSER_ATTACH_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_DETACH_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FOCUS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_RELOAD_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_STOP_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import type { DesktopBrowserViewManager } from "./desktop-browser-view.js";

function hostWindowFromBrowserIpcEvent(
  event: IpcMainEvent,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerRequestCommand<T>(
  channel: string,
  schema: z.ZodType<T>,
  run: (args: { hostWindow: BrowserWindow; request: T }) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    const hostWindow = hostWindowFromBrowserIpcEvent(event);
    if (hostWindow === null) {
      return;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    run({ hostWindow, request: parsed.data });
  });
}

export function registerDesktopBrowserIpc(
  manager: DesktopBrowserViewManager,
): void {
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_ATTACH_CHANNEL,
    bbDesktopBrowserAttachRequestSchema,
    (args) => manager.attach(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
    bbDesktopBrowserNavigateRequestSchema,
    (args) => manager.navigate(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
    bbDesktopBrowserSetBoundsRequestSchema,
    (args) => manager.setBounds(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
    bbDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisible(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
    bbDesktopBrowserSetVisibleRequestSchema,
    (args) => manager.setVisibleWithoutFocus(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
    bbDesktopBrowserFindInPageRequestSchema,
    (args) => manager.findInPage(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
    bbDesktopBrowserStopFindInPageRequestSchema,
    (args) => manager.stopFindInPage(args),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_DETACH_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.detach({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
    bbDesktopBrowserSetThreadDiscardedRequestSchema,
    (args) => manager.setThreadDiscarded(args),
  );
  ipcMain.handle(
    HYPERFIDE_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
    (event) => {
      if (BrowserWindow.fromWebContents(event.sender) === null) return [];
      const tabs = manager.listTabs({
        hostWebContentsId: event.sender.id,
        threadId: null,
      });
      return [...new Set(tabs.map((tab) => tab.threadId))];
    },
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_FOCUS_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.focus({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_GO_BACK_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goBack({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.goForward({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_RELOAD_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.reload({ hostWindow, tabId: request.tabId }),
  );
  registerRequestCommand(
    HYPERFIDE_DESKTOP_BROWSER_STOP_CHANNEL,
    bbDesktopBrowserTabRefSchema,
    ({ hostWindow, request }) =>
      manager.stop({ hostWindow, tabId: request.tabId }),
  );
  ipcMain.handle(
    HYPERFIDE_DESKTOP_BROWSER_EVALUATE_CHANNEL,
    async (
      event,
      payload: unknown,
    ): Promise<BbDesktopBrowserEvaluateResult> => {
      const hostWindow = BrowserWindow.fromWebContents(event.sender);
      if (hostWindow === null) {
        return { ok: false, error: "Browser host window is not available" };
      }
      const parsed = bbDesktopBrowserEvaluateRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: "Invalid browser page evaluation request" };
      }
      return manager.evaluate({ hostWindow, request: parsed.data });
    },
  );
}
