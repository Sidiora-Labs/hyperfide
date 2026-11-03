import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeObjectCache } from "./cache.js";
import {
  NativeWorkspaceClient,
  rawDigest,
  repositoryPath,
  type SourceEntry,
  type WorkspaceDescriptor,
  workspaceError,
} from "./client.js";
import { SourceWorkspaceJournal } from "./journal.js";

export async function withWorkspaceParent<T>(
  root: string,
  relative: string,
  create: boolean,
  action: (parent: string, name: string) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux")
    workspaceError(
      "FILESYSTEM_UNSUPPORTED",
      "The initial secure materializer requires Linux descriptor-relative paths",
    );
  const parts = repositoryPath(relative).split("/");
  const handles: fs.FileHandle[] = [];
  try {
    let handle = await fs.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(handle);
    for (const part of parts.slice(0, -1)) {
      const next = `/proc/self/fd/${handle.fd}/${part}`;
      if (create)
        try {
          await fs.mkdir(next, { mode: 0o755 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      handle = await fs.open(
        next,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(handle);
    }
    return await action(`/proc/self/fd/${handle.fd}`, parts.at(-1)!);
  } catch (error) {
    if (
      ["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      workspaceError(
        "UNSAFE_PATH_PARENT",
        "A workspace path ancestor is not a real directory",
      );
    throw error;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}
export interface CapturedFile {
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  bytes: Buffer;
  fingerprint: string;
}
function fingerprint(stat: import("node:fs").BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(":");
}
export async function captureWorkspaceFile(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<CapturedFile> {
  return withWorkspaceParent(root, relative, false, async (parent, name) => {
    const full = parent + "/" + name,
      before = await fs.lstat(full, { bigint: true });
    if (before.size > BigInt(maxBytes))
      workspaceError(
        "FILE_BUDGET",
        "Source file exceeds the workspace file budget",
      );
    if (before.isSymbolicLink()) {
      const bytes = await fs.readlink(full, { encoding: "buffer" });
      const after = await fs.lstat(full, { bigint: true });
      if (fingerprint(before) !== fingerprint(after))
        workspaceError(
          "UNSTABLE_FILE",
          "Symlink changed while capturing its target",
        );
      return {
        kind: "symlink",
        mode: "120000",
        bytes,
        fingerprint: fingerprint(after),
      };
    }
    if (!before.isFile())
      workspaceError(
        "FILE_TYPE_UNSUPPORTED",
        "Only regular source files and symlinks may be captured",
      );
    const handle = await fs.open(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (fingerprint(before) !== fingerprint(opened))
        workspaceError("UNSTABLE_FILE", "Source file changed before opening");
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let received = 0;
      while (received < buffer.length) {
        const part = await handle.read(
          buffer,
          received,
          buffer.length - received,
          null,
        );
        if (!part.bytesRead) break;
        received += part.bytesRead;
      }
      const bytes = buffer.subarray(0, received);
      const after = await handle.stat({ bigint: true });
      const linked = await fs.lstat(full, { bigint: true });
      if (
        fingerprint(opened) !== fingerprint(after) ||
        fingerprint(after) !== fingerprint(linked) ||
        BigInt(bytes.length) !== after.size
      )
        workspaceError(
          "UNSTABLE_FILE",
          "Source file changed while capturing its bytes",
        );
      return {
        kind: "file",
        mode: (after.mode & 0o111n) !== 0n ? "100755" : "100644",
        bytes,
        fingerprint: fingerprint(after),
      };
    } finally {
      await handle.close();
    }
  });
}
function decimal(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    workspaceError(
      "FILE_DESCRIPTOR",
      "Canonical bounded decimal length required",
    );
  return Number(value);
}
export class SparseSourceMaterializer {
  constructor(
    readonly client: NativeWorkspaceClient,
    readonly cache: NativeObjectCache,
    readonly journal: SourceWorkspaceJournal,
    readonly root: string,
  ) {
    for (const privatePath of [cache.root, journal.directory]) {
      const relative = path.relative(
        path.resolve(root),
        path.resolve(privatePath),
      );
      if (
        relative === "" ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      )
        workspaceError(
          "PRIVATE_STATE_PATH",
          "Cache and dirty journal must live outside the materialized source tree",
        );
    }
  }
  private async object(
    descriptor: WorkspaceDescriptor,
    filename: string,
    id: string,
    signal?: AbortSignal,
  ) {
    return this.cache.acquire(
      descriptor.scope,
      id,
      () => this.client.readObject(id, signal),
      () => this.client.assertAccess(descriptor, filename, false, signal),
    );
  }
  async readEntry(
    descriptor: WorkspaceDescriptor,
    filename: string,
    entry: SourceEntry,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const acquired = await this.object(
      descriptor,
      filename,
      entry.object_id,
      signal,
    );
    try {
      if (entry.kind === "symlink") {
        if (
          acquired.object.kind !== "blob" ||
          acquired.object.payload.length > 4096
        )
          workspaceError(
            "SYMLINK_UNSUPPORTED",
            "Symlink content must be a bounded UTF-8 blob",
          );
        return acquired.object.payload;
      }
      if (entry.kind !== "file" || acquired.object.kind !== "file")
        workspaceError("FILE_DESCRIPTOR", "File descriptor object required");
      let tuple: unknown;
      try {
        tuple = JSON.parse(acquired.object.payload.toString("utf8"));
      } catch {
        workspaceError("FILE_DESCRIPTOR", "Invalid file descriptor JSON");
      }
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        tuple[0] !== 1 ||
        JSON.stringify(tuple) !== acquired.object.payload.toString("utf8")
      )
        workspaceError(
          "FILE_DESCRIPTOR",
          "Canonical file descriptor tuple required",
        );
      const size = decimal(tuple[1]);
      if (size > descriptor.budgets.max_file_bytes)
        workspaceError(
          "FILE_BUDGET",
          "File exceeds the admitted workspace budget",
        );
      const digest = tuple[2],
        content = tuple[3];
      if (
        typeof digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(digest) ||
        !Array.isArray(content) ||
        content.length !== 2
      )
        workspaceError("FILE_DESCRIPTOR", "Invalid descriptor content");
      const parts: Buffer[] = [];
      if (
        content[0] === "blob" &&
        typeof content[1] === "string" &&
        size <= 4 * 1024 * 1024
      ) {
        const child = await this.object(
          descriptor,
          filename,
          content[1],
          signal,
        );
        try {
          if (child.object.kind !== "blob")
            workspaceError(
              "FILE_DESCRIPTOR",
              "Blob descriptor child has a different type",
            );
          parts.push(child.object.payload);
        } finally {
          await child.release();
        }
      } else if (
        content[0] === "chunks" &&
        Array.isArray(content[1]) &&
        size > 4 * 1024 * 1024 &&
        content[1].length <= 4096
      ) {
        for (let index = 0; index < content[1].length; index++) {
          const part = content[1][index];
          if (
            !Array.isArray(part) ||
            part.length !== 2 ||
            typeof part[0] !== "string"
          )
            workspaceError("FILE_DESCRIPTOR", "Invalid chunk descriptor");
          const length = decimal(part[1]);
          if (
            length < 1 ||
            length > 4 * 1024 * 1024 ||
            (index < content[1].length - 1 && length !== 4 * 1024 * 1024)
          )
            workspaceError("FILE_DESCRIPTOR", "Invalid canonical chunk length");
          const child = await this.object(
            descriptor,
            filename,
            part[0],
            signal,
          );
          try {
            if (
              child.object.kind !== "chunk" ||
              child.object.payload.length !== length
            )
              workspaceError(
                "OBJECT_INTEGRITY",
                "Chunk type or length mismatch",
              );
            parts.push(child.object.payload);
          } finally {
            await child.release();
          }
        }
      } else
        workspaceError(
          "FILE_DESCRIPTOR",
          "Invalid file content representation",
        );
      const bytes = Buffer.concat(parts);
      if (bytes.length !== size || rawDigest(bytes) !== digest)
        workspaceError(
          "OBJECT_INTEGRITY",
          "Logical source file digest or length mismatch",
        );
      return bytes;
    } finally {
      await acquired.release();
    }
  }
  private async install(
    descriptor: WorkspaceDescriptor,
    filename: string,
    entry: SourceEntry,
    bytes: Buffer,
  ): Promise<void> {
    repositoryPath(filename);
    await this.client.assertAccess(descriptor, filename);
    const state = await this.journal.snapshot();
    if (state.entries.some((e) => e.path === filename))
      workspaceError(
        "WORKSPACE_DIRTY",
        "Materialization cannot overwrite dirty source",
      );
    try {
      const existing = await captureWorkspaceFile(
        this.root,
        filename,
        descriptor.budgets.max_file_bytes,
      );
      if (
        existing.kind !== entry.kind ||
        existing.mode !== entry.mode ||
        !existing.bytes.equals(bytes)
      )
        workspaceError(
          "WORKSPACE_DIRTY",
          "Existing source differs; retain local bytes",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await withWorkspaceParent(
        this.root,
        filename,
        true,
        async (parent, name) => {
          if (entry.kind === "symlink") {
            const target = bytes.toString("utf8");
            if (
              !Buffer.from(target).equals(bytes) ||
              target.includes("\0") ||
              path.posix.isAbsolute(target) ||
              target.includes("\\")
            )
              workspaceError(
                "SYMLINK_UNSUPPORTED",
                "The filesystem profile requires relative UTF-8 symlinks",
              );
            const resolved = path.posix.normalize(
              path.posix.join(path.posix.dirname(filename), target),
            );
            if (resolved === ".." || resolved.startsWith("../"))
              workspaceError(
                "SYMLINK_ESCAPE",
                "Symlink target escapes the workspace",
              );
            await fs.symlink(target, parent + "/" + name);
          } else {
            const temporary = parent + "/.hyperfide-install-" + randomUUID();
            const handle = await fs.open(
              temporary,
              "wx",
              entry.mode === "100755" ? 0o755 : 0o644,
            );
            try {
              await handle.writeFile(bytes);
              await handle.sync();
            } finally {
              await handle.close();
            }
            try {
              await fs.link(temporary, parent + "/" + name);
            } finally {
              await fs.rm(temporary, { force: true });
            }
          }
        },
      );
    }
    await this.journal.install({
      ...entry,
      path: filename,
      payload_digest: rawDigest(bytes),
      size_bytes: bytes.length,
    });
  }
  async materialize(
    descriptor: WorkspaceDescriptor,
    selected: string[],
    signal?: AbortSignal,
  ): Promise<{
    state: "READY";
    files: number;
    bytes: number;
    physically_materialized: boolean;
  }> {
    if (descriptor.mode === "API_ONLY") {
      if (selected.length)
        workspaceError(
          "WORKSPACE_MODE",
          "API-only workspaces do not materialize paths",
        );
      return {
        state: "READY",
        files: 0,
        bytes: 0,
        physically_materialized: false,
      };
    }
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const installed = new Map(
      (await this.journal.snapshot()).installed.map((e) => [
        e.path,
        e.size_bytes,
      ]),
    );
    let installedBytes = [...installed.values()].reduce(
      (total, size) => total + size,
      0,
    );
    let files = 0,
      bytes = 0;
    const visited = new Set<string>();
    const visit = async (
      filename: string,
      entry: SourceEntry,
    ): Promise<void> => {
      signal?.throwIfAborted();
      repositoryPath(filename);
      if (visited.has(filename)) return;
      visited.add(filename);
      if (entry.kind === "directory") {
        await this.client.assertAccess(descriptor, filename, false, signal);
        await withWorkspaceParent(
          this.root,
          filename,
          true,
          async (parent, name) => {
            const target = parent + "/" + name;
            try {
              await fs.mkdir(target, { mode: 0o755 });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST")
                throw error;
            }
            const handle = await fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            await handle.close();
          },
        );
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await this.client.entries(
            entry.object_id,
            cursor,
            signal,
          );
          for (const child of page.entries) {
            repositoryPath(child.name);
            if (child.name.includes("/"))
              workspaceError("TREE_ENTRY", "Tree entry must be one exact name");
            await visit(
              filename ? filename + "/" + child.name : child.name,
              child,
            );
          }
          cursor = page.next_cursor ?? undefined;
          if (cursor && cursors.has(cursor))
            workspaceError("TREE_PAGINATION", "Tree cursor did not advance");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      } else {
        const content = await this.readEntry(
          descriptor,
          filename,
          entry,
          signal,
        );
        if (
          installedBytes - (installed.get(filename) ?? 0) + content.length >
          descriptor.budgets.materialized_bytes
        )
          workspaceError(
            "MATERIALIZATION_BUDGET",
            "Selected source exceeds the admitted materialization budget",
          );
        await this.install(descriptor, filename, entry, content);
        installedBytes += content.length - (installed.get(filename) ?? 0);
        installed.set(filename, content.length);
        files++;
        bytes += content.length;
      }
    };
    for (const filename of selected) {
      if (filename === "") {
        if (!descriptor.read_paths.includes(""))
          workspaceError(
            "SOURCE_ACCESS_DENIED",
            "Whole-root materialization requires explicit root scope",
          );
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await this.client.entries(
            descriptor.root_tree_id,
            cursor,
            signal,
          );
          for (const child of page.entries) await visit(child.name, child);
          cursor = page.next_cursor ?? undefined;
          if (cursor && cursors.has(cursor))
            workspaceError(
              "TREE_PAGINATION",
              "Root tree cursor did not advance",
            );
          if (cursor) cursors.add(cursor);
        } while (cursor);
      } else {
        await this.client.assertAccess(
          descriptor,
          repositoryPath(filename),
          false,
          signal,
        );
        const entry = await this.client.lookup(
          descriptor.root_tree_id,
          filename,
          signal,
        );
        if (!entry)
          workspaceError(
            "SOURCE_PATH_ABSENT",
            "Requested pinned source path does not exist",
          );
        await visit(filename, entry);
      }
    }
    await this.journal.materialized(selected);
    return { state: "READY", files, bytes, physically_materialized: true };
  }
  async reconcile(descriptor: WorkspaceDescriptor): Promise<void> {
    const snapshot = await this.journal.snapshot();
    for (const installed of snapshot.installed) {
      await this.client.assertAccess(descriptor, installed.path);
      try {
        const actual = await captureWorkspaceFile(
          this.root,
          installed.path,
          descriptor.budgets.max_file_bytes,
        );
        if (
          actual.kind !== installed.kind ||
          actual.mode !== installed.mode ||
          rawDigest(actual.bytes) !== installed.payload_digest
        )
          await this.journal.mark(installed.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          await this.journal.mark(installed.path, "remove");
        else throw error;
      }
    }
    const known = new Set(snapshot.installed.map((e) => e.path)),
      discovered = new Set<string>();
    const scan = async (filename: string): Promise<void> => {
      if (discovered.has(filename)) return;
      discovered.add(filename);
      if (discovered.size > this.journal.maxDirtyPaths * 2)
        workspaceError(
          "RECONCILIATION_BUDGET",
          "Installed sparse scope exceeds the bounded reconciliation inventory",
        );
      const inspect = async (full: string): Promise<void> => {
        const stat = await fs.lstat(full);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const handle = await fs.open(
            full,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            for (const name of await fs.readdir(`/proc/self/fd/${handle.fd}`))
              await scan(filename ? filename + "/" + name : name);
          } finally {
            await handle.close();
          }
        } else if (stat.isFile() || stat.isSymbolicLink()) {
          if (!known.has(filename)) await this.journal.mark(filename);
        } else
          workspaceError(
            "FILE_TYPE_UNSUPPORTED",
            "Sparse source contains an unsupported special file",
          );
      };
      try {
        if (filename === "") await inspect(this.root);
        else
          await withWorkspaceParent(
            this.root,
            filename,
            false,
            (parent, name) => inspect(parent + "/" + name),
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    for (const selected of snapshot.materialized_paths) await scan(selected);
    await this.journal.reconciled();
  }
}
