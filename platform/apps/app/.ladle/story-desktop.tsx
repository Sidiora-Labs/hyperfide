import { useEffect, type ReactNode } from "react";
import type {
  HyperfideDesktopApi,
  HyperfideDesktopBrowserApi,
  HyperfideDesktopBrowserState,
  HyperfideDesktopInfo,
} from "@hyperfide/desktop-contract";

const STORY_DESKTOP_INFO: HyperfideDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-story",
};

function createStoryDesktopBrowserApi(
  initialState: HyperfideDesktopBrowserState | null,
): HyperfideDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    setBounds() {},
    setVisible() {},
    onState(listener) {
      let subscribed = true;
      if (initialState !== null) {
        queueMicrotask(() => {
          if (subscribed) listener(initialState);
        });
      }
      return () => {
        subscribed = false;
      };
    },
    onOpenTab() {
      return () => {};
    },
  };
}

function createStoryDesktopApi(
  browserState: HyperfideDesktopBrowserState | null,
): HyperfideDesktopApi {
  return {
    ...STORY_DESKTOP_INFO,
    browser: createStoryDesktopBrowserApi(browserState),
    async checkForUpdates() {
      return STORY_DESKTOP_INFO;
    },
    async getInfo() {
      return STORY_DESKTOP_INFO;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}

interface WithDesktopBrowserProps {
  browserState?: HyperfideDesktopBrowserState | null;
  children: ReactNode;
}

export function WithDesktopBrowser({
  browserState = null,
  children,
}: WithDesktopBrowserProps) {
  if (typeof window !== "undefined" && window.hyperfideDesktop === undefined) {
    window.hyperfideDesktop = createStoryDesktopApi(browserState);
  }
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        delete window.hyperfideDesktop;
      }
    };
  }, []);
  return <>{children}</>;
}
