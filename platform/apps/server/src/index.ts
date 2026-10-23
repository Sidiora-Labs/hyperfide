import { join } from "node:path";
import { loadServerConfig } from "@hyperfide/config/server";
import {
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@hyperfide/process-utils";

const serverConfig = loadServerConfig();
const diagnosticsLogsDir = join(serverConfig.HYPERFIDE_DATA_DIR, "logs");

installSafeProcessDiagnostics({
  logsDir: diagnosticsLogsDir,
  processName: "server",
});
installSocketTypeOfServiceGuard();

function reportStartupFailure(error: unknown): void {
  try {
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: diagnosticsLogsDir,
      processName: "server",
      error,
    });
  } catch {}

  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const serverModule = await import("./start-server.js");
  await serverModule.runServer(serverConfig);
}

void main().catch(reportStartupFailure);
