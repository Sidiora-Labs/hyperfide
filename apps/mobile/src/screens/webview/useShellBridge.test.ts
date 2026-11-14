import {
  buildBridgeEventScript,
  type NativeScreen,
} from "@hyperfide/mobile-bridge";
import type { WebView } from "react-native-webview";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShellBridge, type ShellBridgeCallbacks } from "./useShellBridge";

const mocks = vi.hoisted(() => ({
  injectJavaScript: vi.fn(),
  openURL: vi.fn(),
  share: vi.fn(),
  haptic: vi.fn(),
  updateBadge: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useCallback: <T>(callback: T) => callback,
    useMemo: <T>(factory: () => T) => factory(),
    useRef: <T>(current: T) => ({ current }),
  };
});
vi.mock("react-native", () => ({
  Linking: { openURL: mocks.openURL },
  Platform: { OS: "android" },
  Share: { share: mocks.share, dismissedAction: "dismissedAction" },
}));
vi.mock("@/lib/haptics", () => ({ haptic: mocks.haptic }));
vi.mock("@/lib/shell", () => ({
  buildBridgeSharePayload: vi.fn(),
  isExternallyOpenable: vi.fn(() => true),
}));
vi.mock("@/notifications/AppBadgeSync", () => ({
  updateAppBadgeCount: mocks.updateBadge,
}));

const callbacks: ShellBridgeCallbacks = {
  onReady: vi.fn(),
  onPath: vi.fn(),
  onOpenNative: vi.fn<(_: NativeScreen) => void>(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("__DEV__", false);
});

describe("useShellBridge clipboard requests", () => {
  it.each([
    {
      kind: "clipboard",
      payload: { text: "A photo", imageUrl: "https://test/photo.png" },
    },
    {
      kind: "clipboard-html",
      payload: { text: "A photo", html: "<pre>A photo</pre>" },
    },
  ] as const)("always replies to $kind", async (request) => {
    const webViewRef = {
      current: { injectJavaScript: mocks.injectJavaScript },
    };
    const bridge = useShellBridge(
      webViewRef as unknown as React.RefObject<WebView | null>,
      callbacks,
    );
    bridge.onMessage({
      nativeEvent: {
        data: JSON.stringify({ type: "request", id: "clipboard-1", request }),
      },
    } as never);

    await vi.waitFor(() =>
      expect(mocks.injectJavaScript).toHaveBeenCalledOnce(),
    );
    expect(mocks.injectJavaScript).toHaveBeenCalledWith(
      buildBridgeEventScript({
        type: "response",
        id: "clipboard-1",
        response: {
          ok: false,
          error: "Clipboard requests are not supported by this app build",
        },
      }),
    );
  });
});
