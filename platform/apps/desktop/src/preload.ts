import {
  bbDesktopServerChoicesSchema,
  MACOS_TRAFFIC_LIGHT_INSET_PX,
  MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
  type BbDesktopServerChoice,
} from "@hyperfide/desktop-contract";
import { contextBridge, ipcRenderer, webFrame } from "electron";
import { appCommandIdSchema, type AppCommandId } from "@hyperfide/domain";
import {
  desktopBrowserImportOutcomeSchema,
  desktopBrowserImportSourceSchema,
} from "@hyperfide/host-daemon-contract";
import { z } from "zod";
import {
  bbDesktopBrowserEvaluateResultSchema,
  bbDesktopBrowserFindResultSchema,
  bbDesktopBrowserOpenTabRequestSchema,
  bbDesktopBrowserPageMessageSchema,
  bbDesktopBrowserScopedOpenTabRequestSchema,
  bbDesktopBrowserTabRefSchema,
  bbDesktopBrowserSnapshotSchema,
  bbDesktopBrowserStateSchema,
  bbDesktopBrowserTargetSchema,
  bbDesktopBrowserControlStateSchema,
  bbDesktopBrowserRevealRequestSchema,
  type BbDesktopBrowserControlState,
  type BbDesktopClipboardContent,
  type BbDesktopBrowserRevealRequest,
  bbDesktopInfoSchema,
  bbDesktopWindowStateSchema,
  type BbDesktopApi,
  type BbDesktopAppCommandHandler,
  type BbDesktopBrowserApi,
  type BbDesktopBrowserFindResultHandler,
  type BbDesktopWindowFindRequest,
  type BbDesktopBrowserPageMessageHandler,
  type BbDesktopBrowserOpenTabHandler,
  type BbDesktopBrowserScopedOpenTabHandler,
  type BbDesktopBrowserFocusHandler,
  type BbDesktopBrowserSnapshotHandler,
  type BbDesktopBrowserStateHandler,
  type BbDesktopBrowserState,
  type BbDesktopBrowserUnsubscribe,
  type BbDesktopBrowserViewBounds,
  type BbDesktopCloseWindowRequestHandler,
  type BbDesktopInfo,
  type BbDesktopInfoChangeHandler,
  type BbDesktopInfoUnsubscribe,
  type BbDesktopOpenNewTabHandler,
  type BbDesktopTheme,
  type BbDesktopWindowState,
  type BbDesktopWindowStateChangeHandler,
  type BbDesktopZoomChangeHandler,
} from "@hyperfide/desktop-contract";
import {
  HYPERFIDE_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  HYPERFIDE_DESKTOP_GET_INFO_CHANNEL,
  HYPERFIDE_DESKTOP_INFO_CHANGED_CHANNEL,
  HYPERFIDE_DESKTOP_INSTALL_UPDATE_CHANNEL,
  HYPERFIDE_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  HYPERFIDE_DESKTOP_SET_THEME_CHANNEL,
  HYPERFIDE_DESKTOP_ZOOM_CHANGED_CHANNEL,
  HYPERFIDE_DESKTOP_ZOOM_COMMAND_CHANNEL,
} from "./desktop-update-ipc.js";
import {
  HYPERFIDE_DESKTOP_BROWSER_ATTACH_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_TARGET_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_CONTROL_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_REVEAL_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_DETACH_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FOCUS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_GO_BACK_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_GO_FORWARD_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_NAVIGATE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_RELOAD_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_STATE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_STOP_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_EVALUATE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
} from "./desktop-browser-ipc.js";
import {
  HYPERFIDE_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  HYPERFIDE_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL,
  HYPERFIDE_DESKTOP_APP_COMMAND_CHANNEL,
  HYPERFIDE_DESKTOP_OPEN_WINDOW_FIND_CHANNEL,
  HYPERFIDE_DESKTOP_RELOAD_WINDOW_CHANNEL,
  HYPERFIDE_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
  HYPERFIDE_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  HYPERFIDE_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  HYPERFIDE_DESKTOP_FOCUS_WINDOW_CHANNEL,
  HYPERFIDE_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  HYPERFIDE_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  HYPERFIDE_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL,
  HYPERFIDE_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  HYPERFIDE_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  HYPERFIDE_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
} from "./desktop-window-command-ipc.js";
import {
  getDesktopVersion,
  resolveBbDesktopPlatform,
} from "./desktop-platform.js";
import { STARTUP_ACTION_CHANNEL } from "./local-view.js";

function createInitialDesktopInfo(): BbDesktopInfo {
  return {
    downloadState: "idle",
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform: resolveBbDesktopPlatform(process.platform),
    updateAvailable: false,
    updateDownloaded: false,
    version: getDesktopVersion(process.env.HYPERFIDE_DESKTOP_VERSION),
  };
}

function createInitialDesktopWindowState(): BbDesktopWindowState {
  return {
    isFullScreen: false,
  };
}

const serverChoiceListeners = new Set<
  (choices: BbDesktopServerChoice[]) => void
>();
const listeners = new Set<BbDesktopInfoChangeHandler>();
const appCommandListeners = new Set<BbDesktopAppCommandHandler>();
const windowStateListeners = new Set<BbDesktopWindowStateChangeHandler>();
let currentInfo = createInitialDesktopInfo();
let currentWindowState = createInitialDesktopWindowState();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(currentInfo);
  }
}

function notifyWindowStateListeners(): void {
  for (const listener of windowStateListeners) {
    listener(currentWindowState);
  }
}

function applyDesktopInfoPayload(payload: unknown): BbDesktopInfo | null {
  const parsed = bbDesktopInfoSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentInfo = parsed.data;
  notifyListeners();
  return currentInfo;
}

function applyDesktopWindowStatePayload(
  payload: unknown,
): BbDesktopWindowState | null {
  const parsed = bbDesktopWindowStateSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  currentWindowState = parsed.data;
  notifyWindowStateListeners();
  return currentWindowState;
}

async function invokeDesktopInfo(channel: string): Promise<BbDesktopInfo> {
  try {
    const payload: unknown = await ipcRenderer.invoke(channel);
    return applyDesktopInfoPayload(payload) ?? currentInfo;
  } catch {
    return currentInfo;
  }
}

async function invokeDesktopWindowState(): Promise<BbDesktopWindowState> {
  try {
    const payload: unknown = await ipcRenderer.invoke(
      HYPERFIDE_DESKTOP_GET_WINDOW_STATE_CHANNEL,
    );
    return applyDesktopWindowStatePayload(payload) ?? currentWindowState;
  } catch {
    return currentWindowState;
  }
}

async function invokeInstallUpdate(): Promise<void> {
  try {
    await ipcRenderer.invoke(HYPERFIDE_DESKTOP_INSTALL_UPDATE_CHANNEL);
  } catch {
    return;
  }
}

const browserStateListeners = new Set<BbDesktopBrowserStateHandler>();
const browserStates = new Map<string, BbDesktopBrowserState>();
browserStateListeners.add((state) => {
  browserStates.delete(state.tabId);
  browserStates.set(state.tabId, state);
  if (browserStates.size > 100) {
    const oldest = browserStates.keys().next().value;
    if (oldest !== undefined) browserStates.delete(oldest);
  }
});
const browserControlListeners = new Set<
  (state: BbDesktopBrowserControlState) => void
>();
const browserRevealListeners = new Set<
  (request: BbDesktopBrowserRevealRequest) => void
>();
const browserOpenTabListeners = new Set<BbDesktopBrowserOpenTabHandler>();
const browserScopedOpenTabListeners =
  new Set<BbDesktopBrowserScopedOpenTabHandler>();
const browserFocusListeners = new Set<BbDesktopBrowserFocusHandler>();
const browserPageMessageListeners =
  new Set<BbDesktopBrowserPageMessageHandler>();
const browserSnapshotListeners = new Set<BbDesktopBrowserSnapshotHandler>();
const browserFindResultListeners = new Set<BbDesktopBrowserFindResultHandler>();
const closeWindowRequestListeners =
  new Set<BbDesktopCloseWindowRequestHandler>();
const openNewTabListeners = new Set<BbDesktopOpenNewTabHandler>();
const zoomListeners = new Set<BbDesktopZoomChangeHandler>();
let lastZoomFactor = webFrame.getZoomFactor();

function publishZoomFactor(factor: number): void {
  document.documentElement.style.setProperty("--bb-zoom", String(factor));
  ipcRenderer.send(HYPERFIDE_DESKTOP_ZOOM_CHANGED_CHANNEL);
}

function notifyZoomChangeIfChanged(): void {
  const zoomFactor = webFrame.getZoomFactor();
  if (zoomFactor === lastZoomFactor) {
    return;
  }
  lastZoomFactor = zoomFactor;
  publishZoomFactor(zoomFactor);
  for (const listener of zoomListeners) {
    listener(zoomFactor);
  }
}

function addListener<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function forwardParsed<T>(
  channel: string,
  schema: z.ZodType<T>,
  listeners: Set<(value: T) => void>,
): void {
  ipcRenderer.on(channel, (_event, payload: unknown) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of listeners) {
      listener(parsed.data);
    }
  });
}

function browserViewBoundsAtWindowScale(
  bounds: BbDesktopBrowserViewBounds,
): BbDesktopBrowserViewBounds {
  const zoomFactor = webFrame.getZoomFactor();
  if (zoomFactor === 1) {
    return bounds;
  }
  const x = Math.round(bounds.x * zoomFactor);
  const y = Math.round(bounds.y * zoomFactor);
  return {
    x,
    y,
    width: Math.max(0, Math.round((bounds.x + bounds.width) * zoomFactor) - x),
    height: Math.max(
      0,
      Math.round((bounds.y + bounds.height) * zoomFactor) - y,
    ),
  };
}

const bbBrowserApi: BbDesktopBrowserApi = {
  async getTarget() {
    return bbDesktopBrowserTargetSchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(HYPERFIDE_DESKTOP_BROWSER_TARGET_CHANNEL),
      );
  },
  async getControl(tabId) {
    return bbDesktopBrowserControlStateSchema.nullable().parse(
      await ipcRenderer.invoke(HYPERFIDE_DESKTOP_BROWSER_GET_CONTROL_CHANNEL, {
        tabId,
      }),
    );
  },
  releaseControl(tabId) {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL, {
      tabId,
    });
  },
  onControl(listener) {
    return addListener(browserControlListeners, listener);
  },
  onReveal(listener) {
    return addListener(browserRevealListeners, listener);
  },
  async evaluate(request) {
    return bbDesktopBrowserEvaluateResultSchema.parse(
      await ipcRenderer.invoke(
        HYPERFIDE_DESKTOP_BROWSER_EVALUATE_CHANNEL,
        request,
      ),
    );
  },
  onPageMessage(listener) {
    return addListener(browserPageMessageListeners, listener);
  },
  attach(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_ATTACH_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  detach(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_DETACH_CHANNEL, { tabId });
  },
  setThreadDiscarded(request): void {
    ipcRenderer.send(
      HYPERFIDE_DESKTOP_BROWSER_SET_THREAD_DISCARDED_CHANNEL,
      request,
    );
  },
  async listThreadIdsWithTabs() {
    return z
      .array(z.string().min(1))
      .parse(
        await ipcRenderer.invoke(
          HYPERFIDE_DESKTOP_BROWSER_LIST_THREADS_WITH_TABS_CHANNEL,
        ),
      );
  },
  navigate(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_NAVIGATE_CHANNEL, request);
  },
  goBack(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_GO_BACK_CHANNEL, { tabId });
  },
  goForward(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_GO_FORWARD_CHANNEL, { tabId });
  },
  reload(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_RELOAD_CHANNEL, { tabId });
  },
  stop(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_STOP_CHANNEL, { tabId });
  },
  focus(tabId): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_FOCUS_CHANNEL, { tabId });
  },
  setBounds(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_SET_BOUNDS_CHANNEL, {
      ...request,
      bounds: browserViewBoundsAtWindowScale(request.bounds),
    });
  },
  setVisible(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_CHANNEL, request);
  },
  setVisibleWithoutFocus(request): void {
    ipcRenderer.send(
      HYPERFIDE_DESKTOP_BROWSER_SET_VISIBLE_WITHOUT_FOCUS_CHANNEL,
      request,
    );
  },
  onState(listener): BbDesktopBrowserUnsubscribe {
    const unsubscribe = addListener(browserStateListeners, listener);
    for (const state of browserStates.values()) listener(state);
    return unsubscribe;
  },
  onOpenTab(listener): BbDesktopBrowserUnsubscribe {
    return addListener(browserOpenTabListeners, listener);
  },
  onScopedOpenTab(listener): BbDesktopBrowserUnsubscribe {
    return addListener(browserScopedOpenTabListeners, listener);
  },
  onFocus(listener): BbDesktopBrowserUnsubscribe {
    return addListener(browserFocusListeners, listener);
  },
  onSnapshot(listener): BbDesktopBrowserUnsubscribe {
    return addListener(browserSnapshotListeners, listener);
  },
  findInPage(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_FIND_IN_PAGE_CHANNEL, request);
  },
  stopFindInPage(request): void {
    ipcRenderer.send(
      HYPERFIDE_DESKTOP_BROWSER_STOP_FIND_IN_PAGE_CHANNEL,
      request,
    );
  },
  onFindResult(listener): BbDesktopBrowserUnsubscribe {
    return addListener(browserFindResultListeners, listener);
  },
  async listImportSources() {
    const payload: unknown = await ipcRenderer.invoke(
      HYPERFIDE_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    );
    return z
      .object({ sources: z.array(desktopBrowserImportSourceSchema) })
      .parse(payload);
  },
  async importCookies(request) {
    const payload: unknown = await ipcRenderer.invoke(
      HYPERFIDE_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
      request,
    );
    return desktopBrowserImportOutcomeSchema.parse(payload);
  },
  openFullDiskAccessSettings() {
    ipcRenderer.send(
      HYPERFIDE_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    );
  },
};

const bbDesktopApi: BbDesktopApi = {
  browser: bbBrowserApi,
  async getServerChoices() {
    return bbDesktopServerChoicesSchema.parse(
      await ipcRenderer.invoke(HYPERFIDE_DESKTOP_GET_SERVER_CHOICES_CHANNEL),
    );
  },
  onServerChoicesChange(listener) {
    return addListener(serverChoiceListeners, listener);
  },
  selectServer(id) {
    ipcRenderer.send(HYPERFIDE_DESKTOP_SELECT_SERVER_CHANNEL, id);
  },
  get lastCheckedAt() {
    return currentInfo.lastCheckedAt;
  },
  get latestVersion() {
    return currentInfo.latestVersion;
  },
  get pendingVersion() {
    return currentInfo.pendingVersion;
  },
  macosTrafficLightInset: MACOS_TRAFFIC_LIGHT_INSET_PX,
  macosTrafficLightTopInset: MACOS_TRAFFIC_LIGHT_TOP_INSET_PX,
  platform: resolveBbDesktopPlatform(process.platform),
  get serverDaemonLogsAvailable() {
    return currentInfo.serverDaemonLogsAvailable;
  },
  get updateAvailable() {
    return currentInfo.updateAvailable;
  },
  get updateDownloaded() {
    return currentInfo.updateDownloaded;
  },
  version: currentInfo.version,
  checkForUpdates() {
    return invokeDesktopInfo(HYPERFIDE_DESKTOP_CHECK_FOR_UPDATES_CHANNEL);
  },
  getInfo() {
    return invokeDesktopInfo(HYPERFIDE_DESKTOP_GET_INFO_CHANNEL);
  },
  focusWindow() {
    ipcRenderer.send(HYPERFIDE_DESKTOP_FOCUS_WINDOW_CHANNEL);
  },
  getWindowState() {
    return invokeDesktopWindowState();
  },
  installUpdate() {
    return invokeInstallUpdate();
  },
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe {
    return addListener(listeners, listener);
  },
  onWindowStateChange(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe {
    return addListener(windowStateListeners, listener);
  },
  onZoomChange(listener): BbDesktopInfoUnsubscribe {
    return addListener(zoomListeners, listener);
  },
  zoom(command): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_ZOOM_COMMAND_CHANNEL, command);
  },
  onOpenNewTab(listener): BbDesktopInfoUnsubscribe {
    return addListener(openNewTabListeners, listener);
  },
  onAppCommand(listener): BbDesktopInfoUnsubscribe {
    return addListener(appCommandListeners, listener);
  },
  onCloseWindowRequest(listener): BbDesktopInfoUnsubscribe {
    return addListener(closeWindowRequestListeners, listener);
  },
  openWindowFind(request): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_OPEN_WINDOW_FIND_CHANNEL, {
      topOffset: Math.round(request.topOffset * webFrame.getZoomFactor()),
    } satisfies BbDesktopWindowFindRequest);
  },
  async openDataDirectory(): Promise<void> {
    await ipcRenderer.invoke(HYPERFIDE_DESKTOP_OPEN_DATA_DIRECTORY_CHANNEL);
  },
  openExternalUrl(url: string): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL, url);
  },
  async openServerDaemonLogs(): Promise<void> {
    await ipcRenderer.invoke(HYPERFIDE_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL);
  },
  reloadWindow(): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_RELOAD_WINDOW_CHANNEL);
  },
  setSplitNavigationEnabled(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void {
    ipcRenderer.send(
      HYPERFIDE_DESKTOP_SET_SPLIT_NAVIGATION_ENABLED_CHANNEL,
      enabled,
      directionalCommands,
    );
  },
  setTheme(theme: BbDesktopTheme): void {
    ipcRenderer.send(HYPERFIDE_DESKTOP_SET_THEME_CHANNEL, theme);
  },
  async writeClipboard(content: BbDesktopClipboardContent): Promise<void> {
    await ipcRenderer.invoke(
      HYPERFIDE_DESKTOP_WRITE_CLIPBOARD_CHANNEL,
      content,
    );
  },
};

forwardParsed(
  HYPERFIDE_DESKTOP_SERVER_CHOICES_CHANGED_CHANNEL,
  bbDesktopServerChoicesSchema,
  serverChoiceListeners,
);

ipcRenderer.on(
  HYPERFIDE_DESKTOP_INFO_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopInfoPayload(payload);
  },
);

ipcRenderer.on(
  HYPERFIDE_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  (_event, payload: unknown) => {
    applyDesktopWindowStatePayload(payload);
  },
);

ipcRenderer.on(HYPERFIDE_DESKTOP_OPEN_NEW_TAB_CHANNEL, () => {
  for (const listener of openNewTabListeners) {
    listener();
  }
});

forwardParsed(
  HYPERFIDE_DESKTOP_APP_COMMAND_CHANNEL,
  appCommandIdSchema,
  appCommandListeners,
);

ipcRenderer.on(HYPERFIDE_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL, () => {
  let handled = false;
  for (const listener of closeWindowRequestListeners) {
    handled = listener() || handled;
  }
  ipcRenderer.send(HYPERFIDE_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, handled);
});

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_STATE_CHANNEL,
  bbDesktopBrowserStateSchema,
  browserStateListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_CONTROL_CHANNEL,
  bbDesktopBrowserControlStateSchema,
  browserControlListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_REVEAL_CHANNEL,
  bbDesktopBrowserRevealRequestSchema,
  browserRevealListeners,
);

ipcRenderer.on(
  HYPERFIDE_DESKTOP_BROWSER_FOCUSED_CHANNEL,
  (_event, payload: unknown) => {
    const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    for (const listener of browserFocusListeners) {
      listener(parsed.data.tabId);
    }
  },
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_OPEN_TAB_CHANNEL,
  bbDesktopBrowserOpenTabRequestSchema,
  browserOpenTabListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_SCOPED_OPEN_TAB_CHANNEL,
  bbDesktopBrowserScopedOpenTabRequestSchema,
  browserScopedOpenTabListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_SNAPSHOT_CHANNEL,
  bbDesktopBrowserSnapshotSchema,
  browserSnapshotListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_PAGE_MESSAGE_CHANNEL,
  bbDesktopBrowserPageMessageSchema,
  browserPageMessageListeners,
);

forwardParsed(
  HYPERFIDE_DESKTOP_BROWSER_FIND_RESULT_CHANNEL,
  bbDesktopBrowserFindResultSchema,
  browserFindResultListeners,
);

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("resize", notifyZoomChangeIfChanged);
  window.addEventListener("DOMContentLoaded", () => {
    publishZoomFactor(webFrame.getZoomFactor());
    for (const button of document.querySelectorAll<HTMLElement>(
      "[data-startup-action]",
    )) {
      button.addEventListener("click", () => {
        ipcRenderer.send(STARTUP_ACTION_CHANNEL, button.dataset.startupAction);
      });
    }
  });
}

void invokeDesktopInfo(HYPERFIDE_DESKTOP_GET_INFO_CHANNEL);
void invokeDesktopWindowState();

contextBridge.exposeInMainWorld("bbDesktop", bbDesktopApi);
