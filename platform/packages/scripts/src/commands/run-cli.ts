import { resolveCurrentDevProcessEnv } from "@bb/config/runtime";
import { runScriptProcess } from "../lib/process-helpers.js";
import { repoRoot, runMainIfEntrypoint } from "../lib/script-entry.js";

interface CliExecution {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveCliExecution(
  cliArgs: string[] = process.argv.slice(2),
): CliExecution {
  const forwardedArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;
  const env = { ...process.env };
  let args = ["apps/cli/dist/index.js", ...forwardedArgs];
  if (process.env.NODE_ENV !== "production") {
    const devEnv = resolveCurrentDevProcessEnv(repoRoot, process.env);
    env.HYPERFIDE_SERVER_URL =
      process.env.HYPERFIDE_SERVER_URL ?? devEnv.HYPERFIDE_SERVER_URL;
    env.HYPERFIDE_HOST_DAEMON_PORT =
      process.env.HYPERFIDE_HOST_DAEMON_PORT ??
      devEnv.HYPERFIDE_HOST_DAEMON_PORT;
    args = [
      "--conditions=source",
      "--import",
      "tsx",
      "apps/cli/src/index.ts",
      ...forwardedArgs,
    ];
  }
  return {
    args,
    command: process.execPath,
    cwd: repoRoot,
    env,
  };
}

async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const execution = resolveCliExecution(cliArgs);
  process.exitCode = await runScriptProcess({
    args: execution.args,
    command: execution.command,
    cwd: execution.cwd,
    env: execution.env,
    stdio: "inherit",
  });
}

runMainIfEntrypoint(import.meta.url, main);
