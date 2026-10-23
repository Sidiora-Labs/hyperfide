import {
  buildTerminalWebSocketPath,
  type BuildTerminalWebSocketPathArgs,
} from "@hyperfide/client-core";
import { buildBrowserWebSocketUrl } from "@/lib/dev-websocket-url";

type BuildTerminalWebSocketUrlArgs = BuildTerminalWebSocketPathArgs;

export function buildTerminalWebSocketUrl(
  args: BuildTerminalWebSocketUrlArgs,
): string {
  return buildBrowserWebSocketUrl(buildTerminalWebSocketPath(args));
}
