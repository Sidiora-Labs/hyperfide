import { useEffect, useState } from "react";
import type { HyperfideDesktopWindowState } from "@hyperfide/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getHyperfideDesktopInfo,
} from "@/lib/hyperfide-desktop";

export function useDesktopWindowState(): HyperfideDesktopWindowState {
  const [windowState, setWindowState] = useState<HyperfideDesktopWindowState>(
    DEFAULT_DESKTOP_WINDOW_STATE,
  );

  useEffect(() => {
    const desktopApi = getHyperfideDesktopInfo();
    let cancelled = false;

    const unsubscribe = desktopApi?.onWindowStateChange?.((nextState) => {
      setWindowState(nextState);
    });

    void desktopApi?.getWindowState?.().then((nextState) => {
      if (!cancelled) {
        setWindowState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return windowState;
}
