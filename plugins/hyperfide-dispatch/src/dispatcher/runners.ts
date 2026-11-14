import {
  SourceControlClient,
  type SourceClientOptions,
} from "@hyperfide/source-control";
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
const LEGACY_RUNNER_COMPATIBILITY = {
  backend: "legacy",
  compatibility: "git-tip-bundle-v1",
} as const;
export function commandRunner(
  kind: string,
  mcp: Record<string, unknown>,
  source?: SourceClientOptions,
): TaskRunner {
  return {
    async run(packet, machine, key) {
      const assignment = packet.assignment ?? LEGACY_RUNNER_COMPATIBILITY;
      if (source && assignment.backend !== "native")
        throw new Error("Native runner requires an assignment descriptor");
      const native = assignment.backend === "native";
      if (native && !source)
        throw new Error("Native source SDK configuration is required");
      if (
        assignment.backend === "legacy" &&
        assignment.compatibility !== "git-tip-bundle-v1"
      )
        throw new Error("Unsupported legacy compatibility");
      const client = native ? new SourceControlClient(source!) : undefined;
      if (native && client) {
        if (
          Object.entries(client.scope).some(
            ([name, value]) =>
              assignment.scope[name as keyof typeof assignment.scope] !== value,
          )
        )
          throw new Error("Native source scope mismatch");
        const current = await client.fleetAssignment(assignment.assignment_id, {
          authority: assignment.authority,
        });
        if (
          packet.task !== assignment.task_id ||
          current.task_id !== assignment.task_id ||
          current.assignment_generation !== assignment.assignment_generation ||
          current.attempt_id !== assignment.attempt_id ||
          current.attempt_generation !== assignment.attempt_generation ||
          current.workspace_id !== assignment.workspace_id ||
          current.base_revision_id !== assignment.revision_id ||
          current.root_tree_id !== assignment.root_tree_id ||
          current.closure_digest !== assignment.closure_id ||
          current.environment_digest !== assignment.environment_id ||
          current.workspace.workspace_generation !==
            assignment.workspace_generation
        )
          throw new Error("Native source assignment changed");
        await machine.writeFile(
          "/tmp/hyperfide-assignment.json",
          Buffer.from(JSON.stringify(assignment)),
          { mode: 0o600 },
        );
      }
      const base = native
        ? undefined
        : await machine.exec("git rev-parse HEAD", { cwd: "/workspace" });
      if (base && (base.exitCode || base.timedOut))
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
      if (native && client) {
        const { workspace } = await client.call<{
          workspace: {
            workspace_generation: string;
            checkpoint_revision_id: string | null;
          };
        }>(
          "source.workspaces.detail",
          { workspace_id: assignment.workspace_id },
          { authority: assignment.authority },
        );
        if (!workspace.checkpoint_revision_id)
          throw new Error("Native runner exited without a durable checkpoint");
        const submission = await client.submitFleetSource(
          {
            assignment_id: assignment.assignment_id,
            expected_assignment_generation: assignment.assignment_generation,
            expected_workspace_generation: workspace.workspace_generation,
            revision_id: workspace.checkpoint_revision_id,
          },
          {
            operation_id: assignment.attempt_id,
            idempotency_key: assignment.attempt_id,
            authority: assignment.authority,
          },
        );
        return { ...result, commits: [], submission };
      }
      const commits = await machine.exec(
        `git rev-list --reverse ${quote(base!.stdout.trim() + "..HEAD")}`,
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
