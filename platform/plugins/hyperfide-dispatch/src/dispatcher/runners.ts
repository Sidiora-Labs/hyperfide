import {
  CLAUDE_RUNNER_KIND,
  claudeDispatchCommand,
} from "../../../provider-claude-code/src/dispatch-command.js";
import type { TaskRunner } from "./contracts";
import {
  CODEX_RUNNER_KIND,
  codexDispatchCommand,
} from "../../../provider-codex/src/dispatch-command.js";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function toml(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(toml).join(", ") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{ " +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + " = " + toml(v))
        .join(", ") +
      " }"
    );
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  throw new Error("Unsupported MCP configuration value");
}
export function commandRunner(
  kind: string,
  mcp: Record<string, unknown>,
): TaskRunner {
  return {
    async run(packet, machine, key) {
      const base = await machine.exec("git rev-parse HEAD", {
        cwd: "/workspace",
      });
      if (base.exitCode || base.timedOut)
        throw new Error("Cannot read runner base commit");
      await machine.writeFile(
        "/tmp/hyperfide-task.txt",
        Buffer.from(packet.prompt),
        { mode: 0o600 },
      );
      await machine.writeFile(
        "/tmp/hyperfide-mcp.json",
        Buffer.from(JSON.stringify({ mcpServers: { codify: mcp } })),
        { mode: 0o600 },
      );
      const runner = fleetRunners.find((runner) => runner.kind === kind);
      if (!runner) throw new Error("Unknown fleet runner kind");
      const command = runner.command(quote("mcp_servers.codify=" + toml(mcp)));
      const result = await machine.exec(command, {
        cwd: "/workspace",
        env: { HYPERFIDE_GATEWAY_KEY: key },
      });
      if (result.exitCode || result.timedOut)
        return {
          ...result,
          exitCode: result.timedOut ? 124 : result.exitCode,
          commits: [],
        };
      const commits = await machine.exec(
        `git rev-list --reverse ${quote(base.stdout.trim() + "..HEAD")}`,
        { cwd: "/workspace" },
      );
      if (commits.exitCode || commits.timedOut)
        throw new Error("Cannot collect runner commits");
      return {
        ...result,
        commits: commits.stdout.trim().split("\n").filter(Boolean),
      };
    },
  };
}

/** Image builders and dispatch share the provider-owned runner catalog. */
export const fleetRunners = [
  {
    kind: CODEX_RUNNER_KIND,
    command: codexDispatchCommand,
    probe: `${CODEX_RUNNER_KIND} --version`,
  },
  {
    kind: CLAUDE_RUNNER_KIND,
    command: claudeDispatchCommand,
    probe: `${CLAUDE_RUNNER_KIND} --version`,
  },
];
export function isFleetRunnerKind(kind: string): boolean {
  return fleetRunners.some((runner) => runner.kind === kind);
}

/** Older fleet documents advertise installed CLIs in their image tool probes. */
export function imageRunnerKinds(fleet: {
  runnerKinds?: string[];
  base?: { steps: [string, string, number][] };
}): string[] {
  const kinds =
    fleet.runnerKinds ??
    fleetRunners
      .filter((runner) =>
        fleet.base?.steps.some(([, command]) => command.includes(runner.probe)),
      )
      .map((runner) => runner.kind);
  if (kinds.some((kind) => !isFleetRunnerKind(kind)))
    throw new Error("Unknown image runner kind");
  return kinds;
}
