import { describe, expect, it } from "vitest";
import { createDesktopIpcAuthorization } from "../src/desktop-ipc-authorization.js";

function event(args: {
  frameUrl: string;
  mainFrameUrl?: string;
  senderId?: number;
}) {
  const mainFrame = { url: args.mainFrameUrl ?? args.frameUrl };
  return {
    sender: { id: args.senderId ?? 7, mainFrame },
    senderFrame:
      args.mainFrameUrl === undefined ? mainFrame : { url: args.frameUrl },
  } as never;
}

describe("desktop IPC authorization", () => {
  it("accepts the authorized server origin only from its main frame", () => {
    const authorization = createDesktopIpcAuthorization();
    authorization.authorize(7, "https://remote.example/workspace");

    expect(
      authorization.isAuthorized(
        event({ frameUrl: "https://remote.example/threads/1" }),
      ),
    ).toBe(true);
    expect(
      authorization.isAuthorized(
        event({
          frameUrl: "https://remote.example/threads/1",
          mainFrameUrl: "https://remote.example/workspace",
        }),
      ),
    ).toBe(false);
    expect(
      authorization.isAuthorized(
        event({ frameUrl: "https://attacker.example/steal" }),
      ),
    ).toBe(false);
  });

  it("pins opaque local startup views to their exact URL", () => {
    const authorization = createDesktopIpcAuthorization();
    const localUrl =
      "data:text/html;charset=utf-8,%3Cmain%3Eloading%3C/main%3E";
    authorization.authorize(7, localUrl);

    expect(authorization.isAuthorized(event({ frameUrl: localUrl }))).toBe(
      true,
    );
    expect(
      authorization.isAuthorized(
        event({
          frameUrl: "data:text/html;charset=utf-8,%3Cmain%3Eother%3C/main%3E",
        }),
      ),
    ).toBe(false);
  });

  it("revokes closed windows", () => {
    const authorization = createDesktopIpcAuthorization();
    authorization.authorize(7, "http://127.0.0.1:4312");
    authorization.revoke(7);
    expect(
      authorization.isAuthorized(event({ frameUrl: "http://127.0.0.1:4312/" })),
    ).toBe(false);
  });
});
