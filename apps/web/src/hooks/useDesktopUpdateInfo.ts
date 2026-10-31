import { useEffect, useState } from "react";
import type { HyperfideDesktopApi, HyperfideDesktopInfo } from "@hyperfide/desktop-contract";
import { getHyperfideDesktopInfo } from "@/lib/hyperfide-desktop";

interface DesktopUpdateInfo {
  desktopApi: HyperfideDesktopApi | null;
  desktopInfo: HyperfideDesktopInfo | null;
  isDesktop: boolean;
}

export function useDesktopUpdateInfo(): DesktopUpdateInfo {
  const [desktopApi] = useState<HyperfideDesktopApi | null>(() => getHyperfideDesktopInfo());
  const [desktopInfo, setDesktopInfo] = useState<HyperfideDesktopInfo | null>(null);

  useEffect(() => {
    const api = getHyperfideDesktopInfo();
    if (api === null) {
      return;
    }

    let mounted = true;
    void api
      .getInfo()
      .then((info) => {
        if (mounted) {
          setDesktopInfo(info);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onChange((info) => {
      setDesktopInfo(info);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return { desktopApi, desktopInfo, isDesktop: desktopApi !== null };
}
