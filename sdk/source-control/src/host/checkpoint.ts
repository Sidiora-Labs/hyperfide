import { randomUUID } from "node:crypto";
import {
  NativeWorkspaceClient,
  rawDigest,
  fileObjectId,
  nativeObjectId,
  type CheckpointResult,
  type WorkspaceChange,
  type WorkspaceDescriptor,
  workspaceError,
} from "./client.js";
import {
  SourceWorkspaceJournal,
  type JournalEntry,
  type PendingCheckpoint,
} from "./journal.js";
import {
  captureWorkspaceFile,
  type CapturedFile,
  SparseSourceMaterializer,
} from "./materializer.js";

export class NativeWorkspaceCheckpoint {
  private active = false;
  constructor(
    readonly client: NativeWorkspaceClient,
    readonly journal: SourceWorkspaceJournal,
    readonly root: string,
    readonly materializer?: SparseSourceMaterializer,
  ) {}
  private async finish(
    pending: PendingCheckpoint,
    result: CheckpointResult,
    captured: Map<string, CapturedFile>,
    descriptor: WorkspaceDescriptor,
  ): Promise<CheckpointResult> {
    const receipt = result?.receipt as {
      schema_version?: number;
      scope?: WorkspaceDescriptor["scope"];
      operation_id?: string;
      overlay_generation?: string;
      workspace_generation?: string;
    } | null;
    if (
      !result ||
      !result.workspace ||
      !receipt ||
      receipt.schema_version !== 1 ||
      receipt.operation_id !== pending.request.operation_id ||
      receipt.overlay_generation !== pending.request.overlay_generation ||
      receipt.workspace_generation !== result.workspace.workspace_generation ||
      !receipt.scope ||
      (
        ["organisation_id", "repository_id", "security_domain_id"] as const
      ).some((key) => receipt.scope![key] !== descriptor.scope[key]) ||
      result.workspace.workspace_id !== descriptor.workspace_id ||
      result.workspace.authority_epoch !== descriptor.authority_epoch ||
      BigInt(result.workspace.workspace_generation) !==
        BigInt(pending.request.expected_workspace_generation) + 1n ||
      result.revision_id !== result.workspace.checkpoint_revision_id
    )
      workspaceError(
        "CHECKPOINT_RECEIPT",
        "Checkpoint acknowledgment does not bind the retained workspace generation",
      );
    for (const entry of pending.captured) {
      const change = pending.request.changes.find(
        (c) => c.path === entry.path,
      )!;
      let original = captured.get(entry.path);
      if (!original && change.operation === "put") {
        try {
          const current = await captureWorkspaceFile(
            this.root,
            entry.path,
            descriptor.budgets.max_file_bytes,
          );
          const identity =
            current.kind === "symlink"
              ? nativeObjectId("blob", current.bytes)
              : fileObjectId(current.bytes);
          if (
            identity === change.object_id &&
            current.kind === change.kind &&
            current.mode === change.mode
          )
            original = current;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (original) {
        try {
          const now = await captureWorkspaceFile(
            this.root,
            entry.path,
            descriptor.budgets.max_file_bytes,
          );
          if (
            now.fingerprint !== original.fingerprint ||
            now.kind !== original.kind ||
            now.mode !== original.mode ||
            !now.bytes.equals(original.bytes)
          )
            await this.journal.mark(entry.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            await this.journal.mark(entry.path, "remove");
          else throw error;
        }
        if (change.operation === "put")
          await this.journal.install({
            name: entry.path.split("/").at(-1)!,
            path: entry.path,
            kind: change.kind,
            mode: change.mode,
            object_id: change.object_id,
            payload_digest: rawDigest(original.bytes),
            size_bytes: original.bytes.length,
          });
      } else if (change.operation === "put") {
        await this.journal.mark(entry.path);
      }
    }
    await this.journal.acknowledge(pending.request.operation_id);
    return result;
  }
  async checkpoint(
    descriptor: WorkspaceDescriptor,
    operationId = randomUUID(),
    signal?: AbortSignal,
  ): Promise<CheckpointResult> {
    if (this.active)
      workspaceError(
        "CHECKPOINT_BUSY",
        "A workspace checkpoint is already being captured",
      );
    this.active = true;
    try {
      let state = await this.journal.snapshot();
      if (state.pending) {
        const previous = await this.client.operation(
          state.pending.request.operation_id,
          signal,
        );
        if (
          ["COMMITTED", "SUCCEEDED", "COMPLETED"].includes(previous.state) &&
          previous.result
        )
          return await this.finish(
            state.pending,
            previous.result,
            new Map(),
            descriptor,
          );
        if (!["ABSENT", "NOT_FOUND"].includes(previous.state))
          workspaceError(
            "CHECKPOINT_UNRESOLVED",
            "The previous checkpoint outcome must be resolved before another mutation",
          );
        return await this.finish(
          state.pending,
          await this.client.checkpoint(state.pending.request, signal),
          new Map(),
          descriptor,
        );
      }
      if (this.materializer) await this.materializer.reconcile(descriptor);
      state = await this.journal.snapshot();
      if (state.overflow)
        workspaceError(
          "JOURNAL_RECONCILIATION_REQUIRED",
          "Reconcile the installed sparse scope after watcher overflow",
        );
      if (state.entries.length > 256)
        workspaceError(
          "CHECKPOINT_BUDGET",
          "A checkpoint supports at most 256 explicit changed paths",
        );
      const captured = new Map<string, CapturedFile>(),
        changes: WorkspaceChange[] = [];
      let dirtyBytes = 0;
      for (const entry of state.entries) {
        signal?.throwIfAborted();
        await this.client.assertAccess(descriptor, entry.path, true, signal);
        if (entry.operation === "remove") {
          try {
            await captureWorkspaceFile(
              this.root,
              entry.path,
              descriptor.budgets.max_file_bytes,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              changes.push({ path: entry.path, operation: "remove" });
              continue;
            }
            throw error;
          }
        }
        const actual = await captureWorkspaceFile(
          this.root,
          entry.path,
          descriptor.budgets.max_file_bytes,
        );
        dirtyBytes += actual.bytes.length;
        if (dirtyBytes > descriptor.budgets.dirty_bytes)
          workspaceError(
            "DIRTY_BUDGET",
            "Dirty source exceeds its admitted checkpoint budget",
          );
        captured.set(entry.path, actual);
        const objectId =
          actual.kind === "symlink"
            ? await this.client.putObject(
                "blob",
                actual.bytes,
                undefined,
                signal,
              )
            : await this.client.putFile(actual.bytes, signal);
        changes.push({
          path: entry.path,
          operation: "put",
          kind: actual.kind,
          mode: actual.mode,
          object_id: objectId,
        });
      }
      for (const [filename, actual] of captured) {
        const now = await captureWorkspaceFile(
          this.root,
          filename,
          descriptor.budgets.max_file_bytes,
        );
        if (
          now.fingerprint !== actual.fingerprint ||
          !now.bytes.equals(actual.bytes)
        )
          workspaceError(
            "UNSTABLE_FILE",
            "An edit raced checkpoint staging; retain dirty source and capture again",
          );
      }
      const after = await this.journal.snapshot();
      if (after.generation !== state.generation)
        workspaceError(
          "UNSTABLE_OVERLAY",
          "The overlay generation changed while capturing source",
        );
      const pending: PendingCheckpoint = {
        request: {
          scope: descriptor.scope,
          workspace_id: descriptor.workspace_id,
          expected_workspace_generation: descriptor.workspace_generation,
          expected_scope_generation: descriptor.scope_generation,
          base_revision_id: descriptor.base_revision_id,
          overlay_generation: state.generation,
          operation_id: operationId,
          changes,
        },
        captured: state.entries.map((e: JournalEntry) => ({ ...e })),
      };
      await this.journal.pending(pending);
      return await this.finish(
        pending,
        await this.client.checkpoint(pending.request, signal),
        captured,
        descriptor,
      );
    } finally {
      this.active = false;
    }
  }
}
