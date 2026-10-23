import { contextBridge, ipcRenderer } from "electron";
import {
  HYPERFIDE_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL,
  HYPERFIDE_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  HYPERFIDE_DESKTOP_BROWSER_PAGE_WORLD_ID,
} from "./desktop-browser-ipc.js";

contextBridge.exposeInIsolatedWorld(
  HYPERFIDE_DESKTOP_BROWSER_PAGE_WORLD_ID,
  HYPERFIDE_DESKTOP_BROWSER_PAGE_BRIDGE_KEY,
  {
    postMessage(channel: unknown, data: unknown): void {
      ipcRenderer.send(HYPERFIDE_DESKTOP_BROWSER_GUEST_MESSAGE_CHANNEL, {
        channel,
        data,
      });
    },
  },
);
