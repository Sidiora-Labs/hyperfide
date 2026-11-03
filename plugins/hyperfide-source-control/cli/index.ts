import type { Command } from "commander";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { executeSourceAction, loadSourceClient } from "../runtime.js";
import { sourceActionSchema, type SourceActionInput } from "../contract.js";

async function readTextFile(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 65536)
      throw new Error(
        "Checkpoint text files must be regular UTF-8 files of at most 64 KiB",
      );
    const bytes = Buffer.alloc(65537);
    let size = 0;
    for (;;) {
      const part = await file.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
      if (size > 65536) throw new Error("Checkpoint file exceeds 64 KiB");
    }
    const after = await file.stat();
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Checkpoint file changed while reading");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    await file.close();
  }
}

export function registerSourceCommands(program: Command): void {
  const source = program
    .command("source")
    .description(
      "Inspect native source and manage durable workspaces without a local repository",
    )
    .option(
      "--config <path>",
      "Protected source connection file",
      process.env.HF_SOURCE_CONFIG,
    )
    .option(
      "--operation-id <uuid>",
      "Reuse the original operation identity when retrying",
    );
  const run = async (action: SourceActionInput, operationId?: string) => {
    const options = source.opts<{ config?: string; operationId?: string }>();
    if (!options.config)
      throw new Error("Provide --config or HF_SOURCE_CONFIG");
    const result = await executeSourceAction(
      await loadSourceClient(options.config),
      operationId ?? options.operationId ?? randomUUID(),
      sourceActionSchema.parse(action),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok)
      process.exitCode = result.error.outcome === "UNKNOWN" ? 75 : 1;
  };
  source.command("metrics").option("--max-rows <rows>","Bounded rows per metric family","1024").action(options=>run({kind:"service-metrics",maxRows:Number(options.maxRows)}));
  source
    .command("revision <revision>")
    .description("Read an immutable revision")
    .action((revisionId) => run({ kind: "revision", revisionId }));
  source
    .command("history <revision>")
    .option("--cursor <cursor>")
    .description("Read a bounded history page")
    .action((revisionId, options) =>
      run({
        kind: "history",
        revisionId,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    );
  source
    .command("diff <before> <after>")
    .option("--cursor <cursor>")
    .description("Compare immutable revisions")
    .action((beforeRevisionId, afterRevisionId, options) =>
      run({
        kind: "diff",
        beforeRevisionId,
        afterRevisionId,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      }),
    );
  source
    .command("open <revision>")
    .requiredOption("--read-path <path...>")
    .option("--write-path <path...>")
    .option("--mode <mode>", "API_ONLY, SPARSE or MATERIALIZED", "API_ONLY")
    .option("--workspace-id <uuid>")
    .description("Open a scoped native workspace")
    .action((revisionId, options) => {
      const operationId =
        source.opts<{ operationId?: string }>().operationId ?? randomUUID();
      return run(
        {
          kind: "open",
          workspaceId: options.workspaceId ?? operationId,
          revisionId,
          readPaths: options.readPath,
          writePaths: options.writePath ?? [],
          mode: options.mode,
        },
        operationId,
      );
    });
  source
    .command("workspace <workspace>")
    .description("Read current workspace generations and durable checkpoint")
    .action((workspaceId) => run({ kind: "workspace", workspaceId }));
  source
    .command("checkpoint <workspace> <path>")
    .requiredOption("--file <file>", "Local UTF-8 file")
    .requiredOption("--base <revision>")
    .requiredOption("--workspace-generation <generation>")
    .requiredOption("--scope-generation <generation>")
    .requiredOption("--overlay-generation <generation>")
    .option("--executable")
    .description("Upload one file and commit a durable checkpoint")
    .action(async (workspaceId, path, options) =>
      run({
        kind: "checkpoint",
        workspaceId,
        path,
        content: await readTextFile(options.file),
        baseRevisionId: options.base,
        workspaceGeneration: options.workspaceGeneration,
        scopeGeneration: options.scopeGeneration,
        overlayGeneration: options.overlayGeneration,
        executable: Boolean(options.executable),
      }),
    );
  source
    .command("merge <ours> <theirs>")
    .requiredOption(
      "--timestamp <iso>",
      "Stable authored timestamp preserved on retries",
    )
    .action((oursRevisionId, theirsRevisionId, options) =>
      run({
        kind: "merge",
        oursRevisionId,
        theirsRevisionId,
        createdAt: options.timestamp,
      }),
    );
  source
    .command("transformation <operation>")
    .action((transformationId) =>
      run({ kind: "transformation", transformationId }),
    );
  source
    .command("assignment <assignment>")
    .action((assignmentId) => run({ kind: "assignment", assignmentId }));
  source
    .command("submit <assignment> <revision>")
    .requiredOption("--assignment-generation <generation>")
    .requiredOption("--workspace-generation <generation>")
    .action((assignmentId, revisionId, options) =>
      run({
        kind: "submit",
        assignmentId,
        revisionId,
        assignmentGeneration: options.assignmentGeneration,
        workspaceGeneration: options.workspaceGeneration,
      }),
    );
  source
    .command("operation <operation>")
    .action((operationId) => run({ kind: "operation", operationId }));
  source
    .command("cancel <operation>")
    .action((operationId) => run({ kind: "cancel-operation", operationId }));
  source
    .command("transfer <transfer>")
    .description("Inspect bounded transfer progress")
    .action((transferId) => run({ kind: "transfer", transferId }));
  source
    .command("complete-transfer <transfer> <object>")
    .description("Verify a transferred native object")
    .action((transferId, objectId) =>
      run({ kind: "complete-transfer", transferId, objectId }),
    );
  source
    .command("cancel-transfer <transfer>")
    .description("Cancel a pending transfer")
    .action((transferId) => run({ kind: "cancel-transfer", transferId }));
  source
    .command("publication <operation>")
    .action((publicationId) => run({ kind: "publication", publicationId }));
  source
    .command("resume-publication <operation>")
    .action((publicationId) =>
      run({ kind: "resume-publication", publicationId }),
    );
  source
    .command("cancel-publication <operation>")
    .action((publicationId) =>
      run({ kind: "cancel-publication", publicationId }),
    );
  source
    .command("qualify <candidate>")
    .requiredOption("--evidence <id...>")
    .action((candidateId, options) =>
      run({ kind: "qualify", candidateId, evidenceIds: options.evidence }),
    );
  source
    .command("accept <candidate> <qualification>")
    .action((candidateId, qualificationId) =>
      run({ kind: "accept", candidateId, qualificationId }),
    );
  source
    .command("publish <acceptance> <destination> <ref>")
    .option("--expected-old <oid>")
    .action((acceptanceId, destinationId, targetRef, options) =>
      run({
        kind: "publish",
        acceptanceId,
        destinationId,
        targetRef,
        expectedOldOid: options.expectedOld ?? null,
      }),
    );
}
