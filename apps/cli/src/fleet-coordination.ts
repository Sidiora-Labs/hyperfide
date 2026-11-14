import type { Command } from "commander";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  AuthorityError,
  authorityConfiguration,
  createAuthorityClient,
  parseFleetDecision,
} from "@hyperfide/authority";

async function readDecision(filename: string): Promise<unknown> {
  if (!filename || !filename.startsWith("/"))
    throw new AuthorityError("INVALID_REQUEST", "Decision file must be an absolute path");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 256 * 1024 || (stat.mode & 0o077))
      throw new AuthorityError("INVALID_REQUEST", "Decision file must be a protected regular file of at most 256 KiB");
    const bytes = await file.readFile();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw new AuthorityError("INVALID_REQUEST", "Decision file is not valid UTF-8 JSON");
  } finally {
    await file.close();
  }
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** Register the typed, confirmation-gated fleet coordination command. */
export function registerFleetCoordinationCommands(program: Command): void {
  const fleet = program
    .command("fleet")
    .description("Coordinate an admitted fleet decision through the authority service");
  fleet
    .command("decision")
    .description("Apply one signed Primary or Feature Manager decision")
    .requiredOption("--file <path>", "Protected JSON decision envelope")
    .requiredOption("--operation-id <uuid>", "Original operation identity (used for replay)")
    .option("--idempotency-key <uuid>", "Transport idempotency key; defaults to operation id")
    .option("--yes", "Confirm the provider/worker effect")
    .action(async (options: { file: string; operationId: string; idempotencyKey?: string; yes?: boolean }) => {
      const operationId = options.operationId;
      try {
        if (!options.yes) {
          print({ ok: false, operation_id: operationId, error: {
            code: "CONFIRMATION_REQUIRED",
            message: "Applying a fleet decision may create provider or worker effects; repeat with --yes",
            retry: "RETRY_SAME_OPERATION", outcome: "KNOWN",
          }});
          process.exitCode = 2;
          return;
        }
        const decision = parseFleetDecision(await readDecision(options.file));
        if (decision.operation_id !== operationId)
          throw new AuthorityError("INVALID_REQUEST", "Decision operation_id must match --operation-id");
        const config = authorityConfiguration(process.env);
        if (!config) throw new AuthorityError("AUTHORITY_CONFIG", "HYPERFIDE_AUTHORITY_URL is required");
        const client = await createAuthorityClient(config);
        const result = await client.fleetDecision(decision, {
          operationId,
          idempotencyKey: options.idempotencyKey ?? operationId,
        });
        print({ ok: true, operation_id: operationId, result });
      } catch (error) {
        const failure = error instanceof AuthorityError
          ? error
          : new AuthorityError("INVALID_REQUEST", error instanceof Error ? error.message : "Fleet decision failed");
        print({ ok: false, operation_id: operationId, error: {
          code: failure.code, message: failure.message,
          retry: failure.code === "OUTCOME_UNKNOWN" ? "RETRY_SAME_OPERATION" : "NEVER",
          outcome: failure.code === "OUTCOME_UNKNOWN" ? "UNKNOWN" : "KNOWN",
          ...(failure.operationId ? { operation_id: failure.operationId } : {}),
        }});
        process.exitCode = failure.code === "OUTCOME_UNKNOWN" ? 75 : 1;
      }
    });
}

