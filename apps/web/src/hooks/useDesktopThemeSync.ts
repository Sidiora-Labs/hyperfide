import { useEffect } from "react";
import { getHyperfideDesktopInfo } from "@/lib/hyperfide-desktop";
import { useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  useEffect(() => {
    const desktopApi = getHyperfideDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);
}
