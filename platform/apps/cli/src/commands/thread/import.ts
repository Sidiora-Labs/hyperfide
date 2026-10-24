import { Command } from "commander";
import {
  threadImportRequestSchema,
  threadImportResponseSchema,
  type ThreadImportRequest,
  type ThreadImportResponse,
} from "@hyperfide/server-contract";
import { action } from "../../action.js";
import { cliFetch } from "../../client.js";
import { outputJson } from "../helpers.js";

export async function importHostSessions(
  baseUrl: string,
  options: ThreadImportRequest,
): Promise<ThreadImportResponse> {
  const response = await cliFetch(
    `${baseUrl.replace(/\/$/, "")}/api/v1/threads/import`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(threadImportRequestSchema.parse(options)),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Session import failed (${response.status}): ${await response.text()}`,
    );
  }
  return threadImportResponseSchema.parse(await response.json());
}

export function registerImportCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("import")
    .description(
      "Import prior Claude Code and Codex sessions from the server host",
    )
    .option("--source <source>", "Import claude-code or codex sessions")
    .option(
      "--root <path>",
      "Override the session source directory on the server host",
    )
    .option("--dry-run", "Discover sessions without writing threads")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (opts: {
          source?: string;
          root?: string;
          dryRun?: boolean;
          json?: boolean;
        }) => {
          const request = threadImportRequestSchema.parse({
            ...(opts.source !== undefined ? { source: opts.source } : {}),
            ...(opts.root !== undefined ? { root: opts.root } : {}),
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          const result = await importHostSessions(getUrl(), request);
          if (outputJson(opts, result)) return;
          console.log(
            `${opts.dryRun ? "Would import" : "Imported"} ${result.imported} sessions; updated ${result.updated}; ${result.records} records.`,
          );
          for (const thread of result.threads)
            console.log(`${thread.id}  ${thread.title}  ${thread.providerId}`);
          for (const error of result.errors)
            console.error(`${error.path}: ${error.message}`);
        },
      ),
    );
}
