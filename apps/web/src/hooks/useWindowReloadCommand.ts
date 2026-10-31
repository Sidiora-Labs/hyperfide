import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getHyperfideDesktopInfo } from "@/lib/hyperfide-desktop";

export function useWindowReloadCommand(): void {
  const desktopApi = getHyperfideDesktopInfo();
  const reloadWindow = desktopApi?.reloadWindow;

  useAppCommandHandler(
    "window.reload",
    () => {
      if (reloadWindow === undefined) {
        return false;
      }
      reloadWindow.call(desktopApi);
      return true;
    },
    0,
    reloadWindow !== undefined,
  );
}
