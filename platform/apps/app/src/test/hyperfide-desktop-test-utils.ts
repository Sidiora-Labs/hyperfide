import type {
  HyperfideDesktopApi,
  HyperfideDesktopBrowserApi,
  HyperfideDesktopInfo,
} from "@hyperfide/desktop-contract";

export function createNoopDesktopBrowserApi(): HyperfideDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    focus() {},
    setBounds() {},
    setVisible() {},
    setVisibleWithoutFocus() {},
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
    onFocus() {
      return () => {};
    },
  };
}

export function createHyperfideDesktopApi(
  info: HyperfideDesktopInfo,
  browser: HyperfideDesktopBrowserApi = createNoopDesktopBrowserApi(),
): HyperfideDesktopApi {
  return {
    ...info,
    browser,
    async checkForUpdates() {
      return info;
    },
    async getInfo() {
      return info;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
