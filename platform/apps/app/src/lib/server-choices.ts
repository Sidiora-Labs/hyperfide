import type { HyperfideDesktopServerChoice } from "@hyperfide/desktop-contract";

export type ServerChoice = HyperfideDesktopServerChoice;

export interface ServerChoices {
  list(): Promise<ServerChoice[]>;
  subscribe(listener: (choices: ServerChoice[]) => void): () => void;
  select(id: string): void;
}

export function getServerChoices(): ServerChoices | null {
  const desktop = typeof window === "undefined" ? undefined : window.hyperfideDesktop;
  if (
    desktop?.getServerChoices &&
    desktop.onServerChoicesChange &&
    desktop.selectServer
  ) {
    return {
      list: desktop.getServerChoices.bind(desktop),
      subscribe: desktop.onServerChoicesChange.bind(desktop),
      select: desktop.selectServer.bind(desktop),
    };
  }
  return null;
}
