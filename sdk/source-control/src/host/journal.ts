import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  repositoryPath,
  type CheckpointRequest,
  type SourceEntry,
  workspaceError,
} from "./client.js";

export interface JournalEntry {
  path: string;
  operation: "dirty" | "remove";
  generation: string;
}
export interface InstalledEntry extends SourceEntry {
  path: string;
  payload_digest: string;
  size_bytes: number;
}
export interface PendingCheckpoint {
  request: CheckpointRequest;
  captured: JournalEntry[];
}
interface JournalState {
  schema_version: 1;
  generation: string;
  entries: JournalEntry[];
  installed: InstalledEntry[];
  overflow: boolean;
  materialized_paths: string[];
  pending: PendingCheckpoint | null;
}
export class SourceWorkspaceJournal {
  private state: JournalState | null = null;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly maxDirtyPaths = 100000,
  ) {
    if (!Number.isSafeInteger(maxDirtyPaths) || maxDirtyPaths < 1)
      workspaceError("JOURNAL_BUDGET", "Positive dirty path limit required");
  }
  private async load(): Promise<JournalState> {
    if (this.state) return this.state;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const content = await fs.readFile(
        path.join(this.directory, "journal.json"),
        "utf8",
      );
      if (content.length > 64 * 1024 * 1024)
        workspaceError("JOURNAL_CORRUPT", "Journal exceeds its bounded format");
      const value = JSON.parse(content) as JournalState;
      if (
        value.schema_version !== 1 ||
        !/^(0|[1-9]\d*)$/.test(value.generation) ||
        !Array.isArray(value.entries) ||
        !Array.isArray(value.installed) ||
        value.entries.length > this.maxDirtyPaths
      )
        workspaceError(
          "JOURNAL_CORRUPT",
          "Unsupported or corrupt workspace journal",
        );
      for (const entry of value.entries) {
        repositoryPath(entry.path);
        if (
          !["dirty", "remove"].includes(entry.operation) ||
          !/^(0|[1-9]\d*)$/.test(entry.generation)
        )
          workspaceError("JOURNAL_CORRUPT", "Invalid journal entry");
      }
      value.materialized_paths ??= [];
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = {
        schema_version: 1,
        generation: "0",
        entries: [],
        installed: [],
        overflow: false,
        materialized_paths: [],
        pending: null,
      };
    }
    return this.state;
  }
  private async persist(): Promise<void> {
    const file = path.join(this.directory, "journal.json"),
      temporary = file + ".tmp-" + randomUUID();
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const dir = await fs.open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private async exclusive<T>(
    body: (state: JournalState) => Promise<T>,
  ): Promise<T> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await body(await this.load());
    } finally {
      release();
    }
  }
  async snapshot(): Promise<JournalState> {
    return this.exclusive(async (state) => structuredClone(state));
  }
  async mark(
    pathname: string,
    operation: "dirty" | "remove" = "dirty",
  ): Promise<string> {
    repositoryPath(pathname);
    return this.exclusive(async (state) => {
      if (
        !state.entries.some((e) => e.path === pathname) &&
        state.entries.length >= this.maxDirtyPaths
      )
        workspaceError(
          "DIRTY_BUDGET",
          "Dirty path journal limit reached; existing dirty data is retained",
        );
      state.generation = String(BigInt(state.generation) + 1n);
      state.entries = state.entries.filter((e) => e.path !== pathname);
      state.entries.push({
        path: pathname,
        operation,
        generation: state.generation,
      });
      await this.persist();
      return state.generation;
    });
  }
  async overflow(): Promise<void> {
    await this.exclusive(async (state) => {
      state.overflow = true;
      await this.persist();
    });
  }
  async reconciled(): Promise<void> {
    await this.exclusive(async (state) => {
      state.overflow = false;
      await this.persist();
    });
  }
  async materialized(paths: string[]): Promise<void> {
    await this.exclusive(async (state) => {
      for (const item of paths) {
        if (item !== "") repositoryPath(item);
        if (!state.materialized_paths.includes(item))
          state.materialized_paths.push(item);
      }
      await this.persist();
    });
  }
  async install(entry: InstalledEntry): Promise<void> {
    repositoryPath(entry.path);
    await this.exclusive(async (state) => {
      if (
        !state.installed.some((e) => e.path === entry.path) &&
        state.installed.length >= this.maxDirtyPaths
      )
        workspaceError(
          "MATERIALIZATION_BUDGET",
          "Installed path journal limit reached",
        );
      state.installed = state.installed.filter((e) => e.path !== entry.path);
      state.installed.push(entry);
      await this.persist();
    });
  }
  async pending(checkpoint: PendingCheckpoint): Promise<void> {
    await this.exclusive(async (state) => {
      if (
        state.pending &&
        JSON.stringify(state.pending) !== JSON.stringify(checkpoint)
      )
        workspaceError(
          "CHECKPOINT_UNRESOLVED",
          "Resolve the retained checkpoint before replacing its operation",
        );
      state.pending = structuredClone(checkpoint);
      await this.persist();
    });
  }
  async acknowledge(operationId: string): Promise<void> {
    await this.exclusive(async (state) => {
      if (!state.pending || state.pending.request.operation_id !== operationId)
        workspaceError(
          "CHECKPOINT_OPERATION",
          "Acknowledgment must match the retained checkpoint",
        );
      const captured = new Map(
        state.pending.captured.map((e) => [e.path, e.generation]),
      );
      state.entries = state.entries.filter(
        (e) => captured.get(e.path) !== e.generation,
      );
      const removed = new Set(
        state.pending.request.changes
          .filter((c) => c.operation === "remove")
          .map((c) => c.path),
      );
      state.installed = state.installed.filter((e) => !removed.has(e.path));
      state.pending = null;
      await this.persist();
    });
  }
}
