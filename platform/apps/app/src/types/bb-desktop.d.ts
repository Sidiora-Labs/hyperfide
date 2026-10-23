import type { BbDesktopApi } from "@hyperfide/desktop-contract";

declare global {
  interface Window {
    bbDesktop?: BbDesktopApi;
  }
}

export {};
