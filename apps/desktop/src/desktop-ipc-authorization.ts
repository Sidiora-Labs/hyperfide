import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

type DesktopIpcEvent = IpcMainEvent | IpcMainInvokeEvent;

interface AuthorizedFrame {
  kind: "exact" | "origin";
  value: string;
}

function frameAuthorization(url: string): AuthorizedFrame {
  try {
    const parsed = new URL(url);
    // Local data/error views have an opaque origin. Keep those pages pinned to
    // the exact URL so an arbitrary data: document cannot use the preload.
    return parsed.origin === "null"
      ? { kind: "exact", value: url }
      : { kind: "origin", value: parsed.origin };
  } catch {
    return { kind: "exact", value: url };
  }
}

function frameMatchesAuthorization(
  frame: { url: string },
  authorization: AuthorizedFrame,
): boolean {
  if (authorization.kind === "exact") {
    return frame.url === authorization.value;
  }
  try {
    return new URL(frame.url).origin === authorization.value;
  } catch {
    return false;
  }
}

/**
 * Tracks the URL that the desktop intentionally loaded in each application
 * window. Privileged IPC is accepted only from that window's top frame and
 * from the expected server origin (or the exact local startup view URL).
 */
export function createDesktopIpcAuthorization() {
  const authorizedFrames = new Map<number, AuthorizedFrame>();

  return {
    authorize(webContentsId: number, url: string): void {
      authorizedFrames.set(webContentsId, frameAuthorization(url));
    },
    revoke(webContentsId: number): void {
      authorizedFrames.delete(webContentsId);
    },
    isAuthorized(event: DesktopIpcEvent): boolean {
      if (
        event.senderFrame === null ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        return false;
      }
      const authorization = authorizedFrames.get(event.sender.id);
      return (
        authorization !== undefined &&
        frameMatchesAuthorization(event.senderFrame, authorization)
      );
    },
  };
}

export type DesktopIpcAuthorization = ReturnType<
  typeof createDesktopIpcAuthorization
>;

export type DesktopIpcAuthorizer = DesktopIpcAuthorization["isAuthorized"];
