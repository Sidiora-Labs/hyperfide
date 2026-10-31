import type { HyperfideDesktopServerChoice } from "./servers.js";
import { z } from "zod";
import type { HyperfideDesktopBrowserApi } from "./browser.js";
import type { HyperfideDesktopWindowFindRequest } from "./find.js";
import { hyperfideDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId } from "@hyperfide/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

const hyperfideDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);

export const hyperfideDesktopInfoSchema = z.object({
  downloadState: hyperfideDesktopDownloadStateSchema.optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: hyperfideDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
});
export type HyperfideDesktopInfo = z.infer<typeof hyperfideDesktopInfoSchema>;

export const hyperfideDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
  })
  .strict();
export type HyperfideDesktopWindowState = z.infer<typeof hyperfideDesktopWindowStateSchema>;

export const hyperfideDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type HyperfideDesktopTheme = z.infer<typeof hyperfideDesktopThemeSchema>;

export const hyperfideDesktopClipboardContentSchema = z
  .object({
    text: z.string(),
    html: z.string().optional(),
  })
  .strict();
export type HyperfideDesktopClipboardContent = z.infer<
  typeof hyperfideDesktopClipboardContentSchema
>;

export const hyperfideDesktopZoomCommandSchema = z.enum(["in", "out", "reset"]);
export type HyperfideDesktopZoomCommand = z.infer<typeof hyperfideDesktopZoomCommandSchema>;
export const HYPERFIDE_DESKTOP_MIN_ZOOM_PERCENT = 50;
export const HYPERFIDE_DESKTOP_MAX_ZOOM_PERCENT = 300;

export type HyperfideDesktopInfoChangeHandler = (info: HyperfideDesktopInfo) => void;
export type HyperfideDesktopInfoUnsubscribe = () => void;
export type HyperfideDesktopWindowStateChangeHandler = (
  state: HyperfideDesktopWindowState,
) => void;
export type HyperfideDesktopZoomChangeHandler = (zoomFactor: number) => void;
export type HyperfideDesktopOpenNewTabHandler = () => void;
export type HyperfideDesktopAppCommandHandler = (command: AppCommandId) => void;
export type HyperfideDesktopCloseWindowRequestHandler = () => boolean;

export interface HyperfideDesktopApi extends HyperfideDesktopInfo {
  browser: HyperfideDesktopBrowserApi;
  getServerChoices?(): Promise<HyperfideDesktopServerChoice[]>;
  onServerChoicesChange?(
    listener: (choices: HyperfideDesktopServerChoice[]) => void,
  ): () => void;
  selectServer?(id: string): void;
  checkForUpdates(): Promise<HyperfideDesktopInfo>;
  getInfo(): Promise<HyperfideDesktopInfo>;
  focusWindow?(): void;
  getWindowState?(): Promise<HyperfideDesktopWindowState>;
  installUpdate(): Promise<void>;
  macosTrafficLightInset?: number;
  macosTrafficLightTopInset?: number;
  onChange(listener: HyperfideDesktopInfoChangeHandler): HyperfideDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: HyperfideDesktopWindowStateChangeHandler,
  ): HyperfideDesktopInfoUnsubscribe;
  onZoomChange?(listener: HyperfideDesktopZoomChangeHandler): HyperfideDesktopInfoUnsubscribe;
  zoom?(command: HyperfideDesktopZoomCommand): void;
  onOpenNewTab?(listener: HyperfideDesktopOpenNewTabHandler): HyperfideDesktopInfoUnsubscribe;
  onAppCommand?(listener: HyperfideDesktopAppCommandHandler): HyperfideDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: HyperfideDesktopCloseWindowRequestHandler,
  ): HyperfideDesktopInfoUnsubscribe;
  openWindowFind?(request: HyperfideDesktopWindowFindRequest): void;
  openDataDirectory?(): Promise<void>;
  openExternalUrl(url: string): void;
  openServerDaemonLogs?(): Promise<void>;
  reloadWindow?(): void;
  setSplitNavigationEnabled?(
    enabled: boolean,
    directionalCommands?: readonly AppCommandId[],
  ): void;
  setTheme(theme: HyperfideDesktopTheme): void;
  writeClipboard?(content: HyperfideDesktopClipboardContent): Promise<void>;
}
