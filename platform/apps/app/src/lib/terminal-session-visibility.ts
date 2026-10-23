import { isActiveTerminalSessionStatus } from "@hyperfide/domain";
import type { TerminalSession } from "@hyperfide/server-contract";

export function isVisibleTerminalSession(session: TerminalSession): boolean {
  return (
    isActiveTerminalSessionStatus(session.status) ||
    session.status === "disconnected"
  );
}
