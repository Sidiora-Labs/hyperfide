import { join } from "node:path";
import {
  hyperfideAppRuntimeVerifyTokens,
  readHyperfideAppRuntimeFile,
  type HyperfideAppRuntimeFile,
} from "@hyperfide/config/app-runtime-file";
import type { VerifiedProcessOps } from "@hyperfide/config/verified-process-stop";
import { SERVER_MOVED_FILE_NAME } from "@hyperfide/server-archive";
import { pathExists } from "./fs.js";

export type LauncherProcessOps = Pick<
  VerifiedProcessOps,
  "isRunning" | "readIdentity"
>;

export interface LauncherMovedMode {
  serverPort: number | null;
}

export async function isLiveHyperfideAppRuntime(
  runtime: HyperfideAppRuntimeFile,
  processOps: LauncherProcessOps,
): Promise<boolean> {
  if (!processOps.isRunning(runtime.pid)) {
    return false;
  }
  const command = (await processOps.readIdentity(runtime.pid))?.command ?? null;
  return (
    command !== null &&
    hyperfideAppRuntimeVerifyTokens(runtime.entryPath).some(
      (token) => token.length > 0 && command.includes(token),
    )
  );
}

export function serverUrlPort(serverUrl: string): number | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.port !== "") {
    return Number(url.port);
  }
  if (url.protocol === "http:") {
    return 80;
  }
  return url.protocol === "https:" ? 443 : null;
}

export async function detectLauncherMovedMode(args: {
  dataDir: string;
  processOps: LauncherProcessOps;
}): Promise<LauncherMovedMode | null> {
  if (!(await pathExists(join(args.dataDir, SERVER_MOVED_FILE_NAME)))) {
    return null;
  }
  const runtime = await readHyperfideAppRuntimeFile(args.dataDir);
  if (
    runtime === null ||
    !(await isLiveHyperfideAppRuntime(runtime, args.processOps))
  ) {
    return null;
  }
  return {
    serverPort: serverUrlPort(runtime.serverUrl),
  };
}
