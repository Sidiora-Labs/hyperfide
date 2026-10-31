import type { HyperfideDesktopApi } from "@hyperfide/desktop-contract";

declare global {
  interface Window {
    hyperfideDesktop?: HyperfideDesktopApi;
  }
}

export {};
