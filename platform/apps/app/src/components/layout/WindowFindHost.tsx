import { useCallback } from "react";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getHyperfideDesktopInfo, readWindowFindTopOffset } from "@/lib/hyperfide-desktop";

export function WindowFindHost() {
  const openWindowFind = useCallback((): boolean => {
    const desktop = getHyperfideDesktopInfo();
    if (desktop?.openWindowFind === undefined) {
      return false;
    }
    desktop.openWindowFind({ topOffset: readWindowFindTopOffset() });
    return true;
  }, []);

  useAppCommandHandler("window.find", openWindowFind);

  return null;
}
