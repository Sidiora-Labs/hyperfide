import type { AppDeps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";

export type ServerMoveModeResolution =
  | { mode: "connect"; connectHandle: string; serverUrl: string }
  | { mode: "direct" }
  | { mode: "unavailable"; message: string };

export type ServerMoveModePlugins = Pick<
  PluginService,
  "getRpcHandler" | "invokeRpcHandler" | "list"
>;

export async function resolveServerMoveMode(
  _deps: Pick<AppDeps, "db" | "hub" | "logger">,
  _plugins: ServerMoveModePlugins,
): Promise<ServerMoveModeResolution> {
  return { mode: "direct" };
}
