import { constants, writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  NativeWorkspaceClient,
  repositoryPath,
  withinScope,
  workspaceError,
  type SourceEntry,
  type WorkspaceDescriptor,
} from "./client.js";
import { NativeObjectCache } from "./cache.js";
import { SourceWorkspaceJournal } from "./journal.js";
import { SparseSourceMaterializer } from "./materializer.js";
import { NativeWorkspaceCheckpoint } from "./checkpoint.js";
import {
  discoverVirtualHost,
  VIRTUAL_FILESYSTEM_PROFILE,
  type VirtualHostConfiguration,
} from "./capabilities.js";

const errno = {
  EPERM: 1,
  ENOENT: 2,
  EINTR: 4,
  EIO: 5,
  EACCES: 13,
  EEXIST: 17,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  EAGAIN: 11,
  EFBIG: 27,
  ENOSPC: 28,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  EOPNOTSUPP: 95,
  ESTALE: 116,
};
const op = {
  LOOKUP: 1,
  FORGET: 2,
  GETATTR: 3,
  SETATTR: 4,
  READLINK: 5,
  SYMLINK: 6,
  MKDIR: 9,
  UNLINK: 10,
  RMDIR: 11,
  RENAME: 12,
  OPEN: 14,
  READ: 15,
  WRITE: 16,
  STATFS: 17,
  RELEASE: 18,
  FSYNC: 20,
  FLUSH: 25,
  INIT: 26,
  OPENDIR: 27,
  READDIR: 28,
  RELEASEDIR: 29,
  FSYNCDIR: 30,
  ACCESS: 34,
  CREATE: 35,
  INTERRUPT: 36,
  DESTROY: 38,
  BATCH_FORGET: 42,
  RENAME2: 45,
};
interface Overlay {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  id: string;
  size: number;
  digest: string;
  removed: boolean;
  dirty?: boolean;
}
interface Node {
  inode: bigint;
  path: string;
  entry: SourceEntry;
  overlay?: Overlay;
  detached?: boolean;
}
interface Handle {
  node: Node;
  bytes?: Buffer;
  writable: boolean;
  directory: boolean;
  names?: { name: string; inode: bigint; kind: string }[];
  iterator?: AsyncGenerator<{ name: string; inode: bigint; kind: string }>;
  exhausted?: boolean;
}
interface State {
  schema_version: 1;
  binding: string;
  descriptor: WorkspaceDescriptor;
  overlay: Overlay[];
}
export interface VirtualMountOptions {
  mountpoint: string;
  stateDirectory: string;
  host: VirtualHostConfiguration;
  uid: number;
  gid: number;
  maxNodes?: number;
  maxOpenHandles?: number;
  maxInflight?: number;
}
function number(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw Object.assign(new Error("Offset exceeds safe integer"), {
      code: "EFBIG",
    });
  return Number(value);
}
function cstring(bytes: Buffer, offset = 0): string {
  const end = bytes.indexOf(0, offset);
  if (end < 0)
    throw Object.assign(new Error("Unterminated name"), { code: "EINVAL" });
  const value = bytes.subarray(offset, end).toString("utf8");
  if (!Buffer.from(value).equals(bytes.subarray(offset, end)))
    throw Object.assign(new Error("Invalid UTF8 name"), { code: "EINVAL" });
  return value;
}
function mode(entry: SourceEntry): number {
  return entry.kind === "directory"
    ? 0o40755
    : entry.kind === "symlink"
      ? 0o120777
      : entry.mode === "100755"
        ? 0o100755
        : 0o100644;
}
function errorNumber(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code && code in errno) return errno[code as keyof typeof errno];
  if (code && /AUTH|DENIED|SCOPE/.test(code)) return errno.EACCES;
  if (code && /STALE|GENERATION|FENCED/.test(code)) return errno.ESTALE;
  if (code && /BUDGET|PRESSURE|LIMIT/.test(code)) return errno.ENOSPC;
  if ((error as { name?: string }).name === "AbortError") return errno.EINTR;
  return errno.EIO;
}
function fail(code: keyof typeof errno): never {
  throw Object.assign(new Error(code), { code });
}
function binding(descriptor: WorkspaceDescriptor): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        descriptor.scope,
        descriptor.workspace_id,
        descriptor.workspace_generation,
        descriptor.scope_generation,
        descriptor.base_revision_id,
        descriptor.root_tree_id,
        descriptor.authority_epoch,
      ]),
    )
    .digest("hex");
}
async function command(
  binary: string,
  args: string[],
  device?: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio:
        device === undefined
          ? ["ignore", "ignore", "pipe"]
          : ["ignore", "ignore", "pipe", device],
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    let diagnostic = "";
    child.stderr!.on("data", (chunk) => {
      if (diagnostic.length < 4096)
        diagnostic += String(chunk).slice(0, 4096 - diagnostic.length);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            Object.assign(
              new Error("Virtual mount command failed: " + diagnostic.trim()),
              { code: "VIRTUAL_MOUNT_FAILED" },
            ),
          );
    });
  });
}

export class NativeVirtualFilesystem {
  private descriptor: WorkspaceDescriptor;
  private device: fs.FileHandle | undefined;
  private serving?: Promise<void>;
  private reader?: Worker;
  private state!: State;
  private nextInode = 2n;
  private nextHandle = 1n;
  private readonly nodes = new Map<bigint, Node>();
  private readonly paths = new Map<string, Node>();
  private readonly handles = new Map<bigint, Handle>();
  private readonly requests = new Map<bigint, AbortController>();
  private readonly hydration = new Map<string, Promise<Buffer>>();
  private readonly activeData = new Map<string, number>();
  private mutation = Promise.resolve();
  private writeQueue = Promise.resolve();
  private readyResolve?: () => void;
  private readyReject?: (error: unknown) => void;
  private stopped = false;
  private ownsMount = false;
  private readonly materializer: SparseSourceMaterializer;
  readonly metrics = {
    metadataRequests: 0,
    contentHydrations: 0,
    hydratedBytes: 0,
    requests: 0,
  };
  constructor(
    readonly client: NativeWorkspaceClient,
    readonly cache: NativeObjectCache,
    readonly journal: SourceWorkspaceJournal,
    descriptor: WorkspaceDescriptor,
    readonly options: VirtualMountOptions,
  ) {
    this.descriptor = structuredClone(descriptor);
    if (descriptor.mode !== "VIRTUAL")
      workspaceError(
        "VIRTUAL_MODE_REQUIRED",
        "An admitted VIRTUAL workspace is required",
      );
    for (const value of [
      options.maxNodes ?? 100000,
      options.maxOpenHandles ?? 128,
      options.maxInflight ?? 32,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        workspaceError(
          "VIRTUAL_BUDGET",
          "Positive virtual filesystem limits required",
        );
    for (const value of [options.uid, options.gid])
      if (!Number.isSafeInteger(value) || value < 0)
        workspaceError(
          "VIRTUAL_IDENTITY",
          "Explicit UNIX uid and gid required",
        );
    const mountpoint = path.resolve(options.mountpoint);
    for (const privatePath of [
      options.stateDirectory,
      cache.root,
      journal.directory,
    ]) {
      const relative = path.relative(mountpoint, path.resolve(privatePath));
      if (
        !relative ||
        (!relative.startsWith(".." + path.sep) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      )
        workspaceError(
          "PRIVATE_STATE_PATH",
          "Virtual state, cache and journal must be outside the mount",
        );
    }
    this.materializer = new SparseSourceMaterializer(
      client,
      cache,
      journal,
      options.mountpoint,
    );
    const root: Node = {
      inode: 1n,
      path: "",
      entry: {
        name: "",
        kind: "directory",
        mode: "040000",
        object_id: descriptor.root_tree_id,
      },
    };
    this.nodes.set(1n, root);
    this.paths.set("", root);
  }
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const prior = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await body();
    } finally {
      release();
    }
  }
  private ownerPath(): string {
    return path.join(this.options.stateDirectory, "owner.json");
  }
  private async claimOwner(): Promise<void> {
    const start = (await fs.readFile("/proc/self/stat", "utf8"))
      .split(") ")[1]!
      .split(" ")[19];
    try {
      const previous = JSON.parse(await fs.readFile(this.ownerPath(), "utf8"));
      if (
        !Number.isSafeInteger(previous.pid) ||
        previous.pid < 1 ||
        typeof previous.start !== "string" ||
        !/^[0-9]+$/.test(previous.start) ||
        previous.workspace_id !== this.descriptor.workspace_id ||
        !/^[0-9a-f]{64}$/.test(previous.binding)
      )
        workspaceError("VIRTUAL_STATE_CORRUPT", "Invalid prior virtual owner");
      try {
        const record = (await fs.readFile(`/proc/${previous.pid}/stat`, "utf8"))
          .split(") ")[1]!
          .split(" ");
        if (record[0] !== "Z" && record[19] === previous.start)
          workspaceError(
            "VIRTUAL_MOUNT_BUSY",
            "The existing virtual daemon is still running",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.unlink(this.ownerPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const owner = await fs.open(this.ownerPath(), "wx", 0o600);
    try {
      await owner.writeFile(
        JSON.stringify({
          pid: process.pid,
          start,
          workspace_id: this.descriptor.workspace_id,
          binding: binding(this.descriptor),
        }),
      );
      await owner.sync();
    } finally {
      await owner.close();
    }
    this.ownsMount = true;
  }
  private statePath(): string {
    return path.join(this.options.stateDirectory, "virtual.json");
  }
  private dataPath(record: Overlay): string {
    return path.join(this.options.stateDirectory, "data", record.id);
  }
  private async writeData(record: Overlay, bytes: Buffer): Promise<void> {
    const file = await fs.open(this.dataPath(record), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await fs.open(path.dirname(this.dataPath(record)), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async reclaimData(): Promise<void> {
    const retained = new Set(
      this.state.overlay
        .filter((record) => !record.removed && record.kind !== "directory")
        .map((record) => record.id),
    );
    for (const name of await fs.readdir(
      path.join(this.options.stateDirectory, "data"),
    )) {
      if (
        !/^[0-9a-f-]{36}$/.test(name) ||
        retained.has(name) ||
        this.activeData.has(name)
      )
        continue;
      await fs
        .unlink(path.join(this.options.stateDirectory, "data", name))
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
  private async readOverlay(record: Overlay): Promise<Buffer> {
    this.activeData.set(record.id, (this.activeData.get(record.id) ?? 0) + 1);
    try {
      const file = await fs.open(
        this.dataPath(record),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== record.size || stat.mode & 0o077)
          workspaceError("VIRTUAL_STATE_CORRUPT", "Invalid overlay bytes");
        const bytes = await file.readFile();
        if (
          "sha256:" + createHash("sha256").update(bytes).digest("hex") !==
          record.digest
        )
          workspaceError(
            "VIRTUAL_STATE_CORRUPT",
            "Overlay content checksum differs",
          );
        return bytes;
      } finally {
        await file.close();
      }
    } finally {
      const remaining = this.activeData.get(record.id)! - 1;
      if (remaining) this.activeData.set(record.id, remaining);
      else this.activeData.delete(record.id);
    }
  }
  private async persist(next: State = this.state): Promise<void> {
    const temporary = this.statePath() + "." + randomUUID();
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(next));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, this.statePath());
    const directory = await fs.open(this.options.stateDirectory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.state = next;
  }
  private async load(): Promise<void> {
    await fs.mkdir(this.options.stateDirectory, {
      recursive: true,
      mode: 0o700,
    });
    const stat = await fs.lstat(this.options.stateDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      workspaceError(
        "VIRTUAL_STATE_UNSAFE",
        "Virtual state must be a private owned directory",
      );
    await fs
      .mkdir(path.join(this.options.stateDirectory, "data"), { mode: 0o700 })
      .catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const dataDirectory = await fs.lstat(
      path.join(this.options.stateDirectory, "data"),
    );
    if (
      !dataDirectory.isDirectory() ||
      dataDirectory.isSymbolicLink() ||
      dataDirectory.uid !== process.getuid?.() ||
      dataDirectory.mode & 0o077
    )
      workspaceError("VIRTUAL_STATE_UNSAFE", "Invalid overlay directory");
    try {
      const file = await fs.open(
        this.statePath(),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let value: State;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64 * 1024 * 1024 || info.mode & 0o077)
          workspaceError("VIRTUAL_STATE_UNSAFE", "Invalid virtual journal");
        value = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      if (
        value.schema_version !== 1 ||
        !value.descriptor ||
        value.binding !== binding(value.descriptor) ||
        !Array.isArray(value.overlay) ||
        value.overlay.length > (this.options.maxNodes ?? 100000)
      )
        workspaceError(
          "WORKSPACE_STALE",
          "Virtual journal belongs to another workspace generation",
        );
      if (value.binding !== binding(this.descriptor)) {
        const pending = (await this.journal.snapshot()).pending;
        if (
          !pending ||
          pending.request.workspace_id !== value.descriptor.workspace_id ||
          pending.request.base_revision_id !==
            value.descriptor.base_revision_id ||
          pending.request.expected_workspace_generation !==
            value.descriptor.workspace_generation
        )
          workspaceError(
            "WORKSPACE_STALE",
            "Virtual journal generation cannot be reconciled",
          );
        const operation = await this.client.operation(
          pending.request.operation_id,
        );
        const accepted = operation.result?.workspace;
        if (
          !["COMMITTED", "SUCCEEDED", "COMPLETED"].includes(operation.state) ||
          !accepted ||
          binding(accepted) !== binding(this.descriptor)
        )
          workspaceError(
            "WORKSPACE_STALE",
            "Pending checkpoint does not explain the current workspace generation",
          );
        value.binding = binding(this.descriptor);
        value.descriptor = structuredClone(this.descriptor);
      }
      const names = new Set<string>();
      for (const entry of value.overlay) {
        repositoryPath(entry.path);
        if (
          names.has(entry.path) ||
          !/^[0-9a-f-]{36}$/.test(entry.id) ||
          !["file", "directory", "symlink"].includes(entry.kind) ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0 ||
          entry.size > this.descriptor.budgets.max_file_bytes ||
          !/^sha256:[0-9a-f]{64}$/.test(entry.digest) ||
          typeof entry.removed !== "boolean"
        )
          workspaceError(
            "VIRTUAL_STATE_CORRUPT",
            "Invalid virtual overlay record",
          );
        names.add(entry.path);
        if (!entry.removed && entry.kind !== "directory") {
          const data = await fs.open(
            this.dataPath(entry),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const file = await data.stat();
            if (
              !file.isFile() ||
              file.size !== entry.size ||
              file.mode & 0o077 ||
              "sha256:" +
                createHash("sha256")
                  .update(await data.readFile())
                  .digest("hex") !==
                entry.digest
            )
              workspaceError(
                "VIRTUAL_STATE_CORRUPT",
                "Overlay bytes differ from durable journal",
              );
          } finally {
            await data.close();
          }
        }
      }
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = {
        schema_version: 1,
        binding: binding(this.descriptor),
        descriptor: structuredClone(this.descriptor),
        overlay: [],
      };
      await this.persist();
    }
    const dirty = this.state.overlay
      .filter((entry) => !entry.removed && entry.dirty !== false)
      .reduce((sum, entry) => sum + entry.size, 0);
    if (dirty > this.descriptor.budgets.dirty_bytes)
      workspaceError(
        "DIRTY_BUDGET",
        "Retained virtual data exceeds current budget",
      );
    for (const entry of this.state.overlay)
      if (
        entry.dirty !== false &&
        (entry.removed || entry.kind !== "directory")
      )
        await this.journal.mark(entry.path, entry.removed ? "remove" : "dirty");
    await this.reclaimData();
  }
  private visible(name: string): boolean {
    return (
      !name ||
      withinScope(name, this.descriptor.read_paths) ||
      this.descriptor.read_paths.some((scope) => scope.startsWith(name + "/"))
    );
  }
  private async current(
    name?: string,
    write = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (name) {
      if (!this.visible(name)) fail("ENOENT");
      if (write || withinScope(name, this.descriptor.read_paths)) {
        await this.client.assertAccess(this.descriptor, name, write, signal);
        return;
      }
    }
    const current = await this.client.detail(
      this.descriptor.workspace_id,
      signal,
    );
    if (binding(current) !== binding(this.descriptor))
      workspaceError("WORKSPACE_STALE", "Virtual workspace generation changed");
  }
  private async lookup(name: string, signal?: AbortSignal): Promise<Node> {
    if (!name) return this.nodes.get(1n)!;
    repositoryPath(name);
    await this.current(name, false, signal);
    const overlay = this.state.overlay.find((record) => record.path === name);
    if (overlay?.removed) fail("ENOENT");
    const retained = this.paths.get(name);
    if (retained && !retained.detached) return retained;
    this.metrics.metadataRequests++;
    const entry: SourceEntry | null = overlay
      ? {
          name: path.posix.basename(name),
          kind: overlay.kind,
          mode:
            overlay.kind === "directory"
              ? "040000"
              : overlay.kind === "symlink"
                ? "120000"
                : overlay.mode & 0o111
                  ? "100755"
                  : "100644",
          object_id: this.descriptor.root_tree_id,
        }
      : await this.client.lookup(this.descriptor.root_tree_id, name, signal);
    if (!entry) fail("ENOENT");
    if (this.nodes.size >= (this.options.maxNodes ?? 100000)) fail("ENOSPC");
    const node: Node = {
      inode: this.nextInode++,
      path: name,
      entry,
      ...(overlay ? { overlay } : {}),
    };
    this.nodes.set(node.inode, node);
    this.paths.set(name, node);
    return node;
  }
  private async size(node: Node, signal?: AbortSignal): Promise<number> {
    if (node.overlay) return node.overlay.size;
    if (node.entry.kind === "directory") return 0;
    await this.current(node.path, false, signal);
    const acquired = await this.cache.acquire(
      this.descriptor.scope,
      node.entry.object_id,
      () => this.client.readObject(node.entry.object_id, signal),
      () => this.current(node.path, false, signal),
    );
    try {
      if (node.entry.kind === "symlink") return acquired.object.payload.length;
      if (acquired.object.kind !== "file")
        workspaceError("FILE_DESCRIPTOR", "Expected a native file descriptor");
      const descriptor = JSON.parse(acquired.object.payload.toString("utf8"));
      if (
        !Array.isArray(descriptor) ||
        descriptor[0] !== 1 ||
        typeof descriptor[1] !== "string" ||
        !/^(0|[1-9]\d*)$/.test(descriptor[1])
      )
        workspaceError("FILE_DESCRIPTOR", "Invalid native file length");
      const length = number(BigInt(descriptor[1]));
      if (length > this.descriptor.budgets.max_file_bytes) fail("EFBIG");
      return length;
    } finally {
      await acquired.release();
    }
  }
  private async bytes(node: Node, signal?: AbortSignal): Promise<Buffer> {
    await this.current(node.path, false, signal);
    if (node.overlay) return this.readOverlay(node.overlay);
    const key = node.entry.object_id + ":" + node.path;
    let pending = this.hydration.get(key);
    if (!pending) {
      pending = this.materializer
        .readEntry(this.descriptor, node.path, node.entry)
        .then((bytes) => {
          this.metrics.contentHydrations++;
          this.metrics.hydratedBytes += bytes.length;
          return bytes;
        })
        .finally(() => this.hydration.delete(key));
      this.hydration.set(key, pending);
    }
    if (!signal) return pending;
    if (signal.aborted) throw signal.reason;
    return new Promise<Buffer>((resolve, reject) => {
      const abort = () =>
        reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      pending!
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  private async attribute(node: Node, signal?: AbortSignal): Promise<Buffer> {
    const size = await this.size(node, signal),
      result = Buffer.alloc(88);
    result.writeBigUInt64LE(node.inode, 0);
    result.writeBigUInt64LE(BigInt(size), 8);
    result.writeBigUInt64LE(BigInt(Math.ceil(size / 512)), 16);
    result.writeUInt32LE(node.overlay?.mode ?? mode(node.entry), 60);
    result.writeUInt32LE(node.entry.kind === "directory" ? 2 : 1, 64);
    result.writeUInt32LE(this.options.uid, 68);
    result.writeUInt32LE(this.options.gid, 72);
    result.writeUInt32LE(4096, 80);
    return result;
  }
  private async entry(node: Node, signal?: AbortSignal): Promise<Buffer> {
    const result = Buffer.alloc(128);
    result.writeBigUInt64LE(node.inode, 0);
    result.writeBigUInt64LE(1n, 8);
    (await this.attribute(node, signal)).copy(result, 40);
    return result;
  }
  private async *directory(
    node: Node,
    signal?: AbortSignal,
  ): AsyncGenerator<{ name: string; inode: bigint; kind: string }> {
    await this.current(node.path, false, signal);
    if (node.entry.kind !== "directory") fail("ENOTDIR");
    yield { name: ".", inode: node.inode, kind: "directory" };
    yield {
      name: "..",
      inode: node.path
        ? (
            await this.lookup(
              path.posix.dirname(node.path) === "."
                ? ""
                : path.posix.dirname(node.path),
              signal,
            )
          ).inode
        : 1n,
      kind: "directory",
    };
    const emitted = new Set<string>();
    if (!node.overlay) {
      let cursor: string | undefined;
      do {
        this.metrics.metadataRequests++;
        const page = await this.client.entries(
          node.entry.object_id,
          cursor,
          signal,
        );
        for (const entry of page.entries) {
          const name = node.path ? node.path + "/" + entry.name : entry.name;
          if (!this.visible(name)) continue;
          const overlay = this.state.overlay.find(
            (value) => value.path === name,
          );
          emitted.add(name);
          if (overlay?.removed) continue;
          const child = await this.lookup(name, signal);
          yield {
            name: entry.name,
            inode: child.inode,
            kind: child.entry.kind,
          };
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }
    for (const entry of this.state.overlay)
      if (
        !entry.removed &&
        !emitted.has(entry.path) &&
        path.posix.dirname(entry.path) === (node.path || ".")
      ) {
        const child = await this.lookup(entry.path, signal);
        yield {
          name: path.posix.basename(entry.path),
          inode: child.inode,
          kind: child.entry.kind,
        };
      }
  }
  private async nonempty(node: Node, signal?: AbortSignal): Promise<boolean> {
    let count = 0;
    for await (const _ of this.directory(node, signal))
      if (++count > 2) return true;
    return false;
  }
  private async store(
    node: Node,
    bytes: Buffer,
    kind: Overlay["kind"] = "file",
    selectedMode?: number,
  ): Promise<void> {
    await this.current(node.path, true);
    if (bytes.length > this.descriptor.budgets.max_file_bytes) fail("EFBIG");
    const held = [...this.handles.values()].reduce(
      (sum, handle) =>
        sum +
        (handle.node.inode === node.inode && !handle.node.detached
          ? bytes.length
          : (handle.bytes?.length ?? 0)),
      0,
    );
    if (held > this.descriptor.budgets.materialized_bytes) fail("ENOSPC");
    const total = this.state.overlay
      .filter(
        (value) =>
          !value.removed && value.dirty !== false && value.path !== node.path,
      )
      .reduce((sum, value) => sum + value.size, bytes.length);
    if (total > this.descriptor.budgets.dirty_bytes) fail("ENOSPC");
    const record: Overlay = {
      path: node.path,
      id: randomUUID(),
      kind,
      mode: selectedMode ?? node.overlay?.mode ?? mode(node.entry),
      size: bytes.length,
      digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      removed: false,
      dirty: true,
    };
    await this.writeData(record, bytes);
    await this.persist({
      ...this.state,
      overlay: [
        ...this.state.overlay.filter((value) => value.path !== node.path),
        record,
      ],
    });
    node.overlay = record;
    for (const handle of this.handles.values())
      if (handle.node.inode === node.inode && !handle.node.detached)
        handle.bytes = bytes;
    if (kind !== "directory") await this.journal.mark(node.path);
    await this.reclaimData();
  }
  private async remove(node: Node): Promise<void> {
    await this.current(node.path, true);
    const record: Overlay = {
      path: node.path,
      id: randomUUID(),
      kind: node.entry.kind,
      mode: mode(node.entry),
      size: 0,
      digest:
        "sha256:" + createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      removed: true,
      dirty: true,
    };
    await this.persist({
      ...this.state,
      overlay: [
        ...this.state.overlay.filter((value) => value.path !== node.path),
        record,
      ],
    });
    node.detached = true;
    this.paths.delete(node.path);
    await this.journal.mark(node.path, "remove");
    await this.reclaimData();
  }
  private child(node: Node, name: string): string {
    if (node.entry.kind !== "directory") fail("ENOTDIR");
    if (!name || name.includes("/") || name === "." || name === "..")
      fail("EINVAL");
    return repositoryPath(node.path ? node.path + "/" + name : name);
  }
  private get(inode: bigint): Node {
    const node = this.nodes.get(inode);
    if (!node) fail("ESTALE");
    return node;
  }
  private handle(id: bigint): Handle {
    const handle = this.handles.get(id);
    if (!handle) fail("ESTALE");
    return handle;
  }
  private async open(
    node: Node,
    flags: number,
    directory: boolean,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (this.handles.size >= (this.options.maxOpenHandles ?? 128))
      fail("ENOSPC");
    if (directory !== (node.entry.kind === "directory"))
      fail(directory ? "ENOTDIR" : "EISDIR");
    const writable = !directory && (flags & 3) !== constants.O_RDONLY;
    await this.current(node.path, writable, signal);
    if (writable && flags & constants.O_TRUNC)
      await this.exclusive(() => this.store(node, Buffer.alloc(0)));
    let bytes: Buffer | undefined;
    if (!directory) bytes = await this.bytes(node, signal);
    const held = [...this.handles.values()].reduce(
      (sum, handle) => sum + (handle.bytes?.length ?? 0),
      bytes?.length ?? 0,
    );
    if (held > this.descriptor.budgets.materialized_bytes) fail("ENOSPC");
    const id = this.nextHandle++;
    this.handles.set(id, {
      node,
      writable,
      directory,
      ...(bytes ? { bytes } : {}),
    });
    const result = Buffer.alloc(16);
    result.writeBigUInt64LE(id);
    result.writeUInt32LE(directory ? 0 : 1, 8);
    return result;
  }
  private async dispatch(
    opcode: number,
    inode: bigint,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<Buffer | null> {
    if (opcode === op.INIT) {
      if (
        body.length < 16 ||
        body.readUInt32LE(0) !== 7 ||
        body.readUInt32LE(4) < 31
      )
        workspaceError(
          "FUSE_PROTOCOL_UNSUPPORTED",
          "Linux FUSE protocol 7.31 or newer required",
        );
      const result = Buffer.alloc(64);
      result.writeUInt32LE(7);
      result.writeUInt32LE(Math.min(body.readUInt32LE(4), 38), 4);
      result.writeUInt16LE(this.options.maxInflight ?? 32, 16);
      result.writeUInt16LE(
        Math.max(1, Math.floor((this.options.maxInflight ?? 32) / 2)),
        18,
      );
      result.writeUInt32LE(128 * 1024, 20);
      result.writeUInt32LE(1, 24);
      return result;
    }
    if ([op.FORGET, op.BATCH_FORGET, op.DESTROY].includes(opcode)) return null;
    const node = this.get(inode);
    switch (opcode) {
      case op.LOOKUP:
        return this.entry(
          await this.lookup(this.child(node, cstring(body)), signal),
          signal,
        );
      case op.GETATTR: {
        await this.current(node.path, false, signal);
        const result = Buffer.alloc(104);
        (await this.attribute(node, signal)).copy(result, 16);
        return result;
      }
      case op.OPEN:
      case op.OPENDIR:
        return this.open(
          node,
          body.readUInt32LE(0),
          opcode === op.OPENDIR,
          signal,
        );
      case op.READ: {
        const handle = this.handle(body.readBigUInt64LE(0));
        await this.current(handle.node.path, false, signal);
        const bytes = handle.bytes!;
        const offset = number(body.readBigUInt64LE(8));
        return bytes.subarray(offset, offset + body.readUInt32LE(16));
      }
      case op.READDIR:
        return this.exclusive(async () => {
          const handle = this.handle(body.readBigUInt64LE(0));
          if (!handle.directory) fail("ENOTDIR");
          handle.names ??= [];
          handle.iterator ??= this.directory(node, signal);
          const offset = number(body.readBigUInt64LE(8)),
            maximum = body.readUInt32LE(16),
            chunks: Buffer[] = [];
          let used = 0;
          for (let index = offset; ; index++) {
            if (index >= handle.names.length) {
              if (handle.exhausted) break;
              const next = await handle.iterator.next();
              if (next.done) {
                handle.exhausted = true;
                break;
              }
              handle.names.push(next.value);
            }
            const item = handle.names[index]!,
              name = Buffer.from(item.name),
              length = (24 + name.length + 7) & ~7;
            if (used + length > maximum) break;
            const row = Buffer.alloc(length);
            row.writeBigUInt64LE(item.inode, 0);
            row.writeBigUInt64LE(BigInt(index + 1), 8);
            row.writeUInt32LE(name.length, 16);
            row.writeUInt32LE(
              item.kind === "directory" ? 4 : item.kind === "symlink" ? 10 : 8,
              20,
            );
            name.copy(row, 24);
            chunks.push(row);
            used += length;
          }
          return Buffer.concat(chunks);
        });
      case op.RELEASE:
      case op.RELEASEDIR:
        this.handles.delete(body.readBigUInt64LE(0));
        return Buffer.alloc(0);
      case op.FLUSH:
      case op.FSYNC:
      case op.FSYNCDIR:
        await this.current(node.path, false, signal);
        return Buffer.alloc(0);
      case op.READLINK:
        if (node.entry.kind !== "symlink") fail("EINVAL");
        return this.bytes(node, signal);
      case op.WRITE:
        return this.exclusive(async () => {
          const handle = this.handle(body.readBigUInt64LE(0));
          if (!handle.writable || handle.directory) fail("EACCES");
          if (handle.node.detached) fail("ESTALE");
          const offset = number(body.readBigUInt64LE(8)),
            size = body.readUInt32LE(16);
          if (body.length !== 40 + size) fail("EINVAL");
          const prior = handle.node.overlay
            ? await this.bytes(handle.node, signal)
            : handle.bytes!;
          if (offset + size > this.descriptor.budgets.max_file_bytes)
            fail("EFBIG");
          const bytes = Buffer.alloc(Math.max(prior.length, offset + size));
          prior.copy(bytes);
          body.copy(bytes, offset, 40);
          await this.store(handle.node, bytes);
          handle.bytes = bytes;
          const result = Buffer.alloc(8);
          result.writeUInt32LE(size);
          return result;
        });
      case op.SETATTR:
        return this.exclusive(async () => {
          const valid = body.readUInt32LE(0);
          if (valid & ~(1 | 8 | 64 | 512 | 2048)) fail("EOPNOTSUPP");
          await this.current(node.path, true, signal);
          if (node.entry.kind === "directory" && valid & 8) fail("EISDIR");
          let bytes =
            node.entry.kind === "directory"
              ? Buffer.alloc(0)
              : await this.bytes(node, signal);
          if (valid & 8) {
            const length = number(body.readBigUInt64LE(16));
            if (length > this.descriptor.budgets.max_file_bytes) fail("EFBIG");
            const resized = Buffer.alloc(length);
            bytes.copy(resized);
            bytes = resized;
          }
          const selectedMode =
            valid & 1
              ? body.readUInt32LE(68)
              : (node.overlay?.mode ?? mode(node.entry));
          await this.store(
            node,
            bytes,
            node.entry.kind,
            (mode(node.entry) & 0o170000) | (selectedMode & 0o777),
          );
          const result = Buffer.alloc(104);
          (await this.attribute(node, signal)).copy(result, 16);
          return result;
        });
      case op.CREATE:
      case op.MKDIR:
      case op.SYMLINK:
        return this.exclusive(async () => {
          const name = this.child(
            node,
            cstring(
              body,
              opcode === op.CREATE ? 16 : opcode === op.MKDIR ? 8 : 0,
            ),
          );
          try {
            await this.lookup(name, signal);
            fail("EEXIST");
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          }
          const kind =
            opcode === op.MKDIR
              ? "directory"
              : opcode === op.SYMLINK
                ? "symlink"
                : "file";
          const entry: SourceEntry = {
            name: path.posix.basename(name),
            kind,
            mode:
              kind === "directory"
                ? "040000"
                : kind === "symlink"
                  ? "120000"
                  : "100644",
            object_id: this.descriptor.root_tree_id,
          };
          const child: Node = { inode: this.nextInode++, path: name, entry };
          if (this.nodes.size >= (this.options.maxNodes ?? 100000))
            fail("ENOSPC");
          let bytes = Buffer.alloc(0);
          if (opcode === op.SYMLINK) {
            const start = body.indexOf(0) + 1;
            bytes = Buffer.from(cstring(body, start));
            if (bytes.length > 4096) fail("EFBIG");
          }
          const selectedMode =
            kind === "directory"
              ? 0o40755
              : kind === "symlink"
                ? 0o120777
                : 0o100000 | (body.readUInt32LE(4) & 0o777);
          await this.store(child, bytes, kind, selectedMode);
          this.nodes.set(child.inode, child);
          this.paths.set(name, child);
          const encoded = await this.entry(child, signal);
          return opcode === op.CREATE
            ? Buffer.concat([
                encoded,
                await this.open(
                  child,
                  body.readUInt32LE(0) & ~constants.O_TRUNC,
                  false,
                  signal,
                ),
              ])
            : encoded;
        });
      case op.UNLINK:
      case op.RMDIR:
        return this.exclusive(async () => {
          const child = await this.lookup(
            this.child(node, cstring(body)),
            signal,
          );
          if (
            opcode === op.RMDIR &&
            (child.entry.kind !== "directory" ||
              (await this.nonempty(child, signal)))
          )
            fail(child.entry.kind === "directory" ? "ENOTEMPTY" : "ENOTDIR");
          if (opcode === op.UNLINK && child.entry.kind === "directory")
            fail("EISDIR");
          await this.remove(child);
          return Buffer.alloc(0);
        });
      case op.RENAME:
      case op.RENAME2:
        return this.exclusive(async () => {
          const parent = this.get(body.readBigUInt64LE(0)),
            start = opcode === op.RENAME ? 8 : 16;
          if (opcode === op.RENAME2 && body.readUInt32LE(8) !== 0)
            fail("EOPNOTSUPP");
          const oldName = cstring(body, start),
            newName = cstring(body, start + Buffer.byteLength(oldName) + 1),
            from = await this.lookup(this.child(node, oldName), signal),
            target = this.child(parent, newName);
          if (from.entry.kind === "directory") fail("EOPNOTSUPP");
          await this.current(target, true, signal);
          const bytes = await this.bytes(from, signal);
          let replaced: Node | undefined;
          try {
            replaced = await this.lookup(target, signal);
            if (replaced.entry.kind === "directory") fail("EISDIR");
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          }
          const oldPath = from.path;
          const destination: Node = {
            inode: from.inode,
            path: target,
            entry: { ...from.entry, name: newName },
          };
          if (target === oldPath) return Buffer.alloc(0);
          const record: Overlay = {
            path: target,
            id: randomUUID(),
            kind: from.entry.kind,
            mode: from.overlay?.mode ?? mode(from.entry),
            size: bytes.length,
            digest:
              "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            removed: false,
            dirty: true,
          };
          const total = this.state.overlay
            .filter(
              (value) =>
                !value.removed &&
                value.dirty !== false &&
                value.path !== oldPath &&
                value.path !== target,
            )
            .reduce((sum, value) => sum + value.size, bytes.length);
          if (total > this.descriptor.budgets.dirty_bytes) fail("ENOSPC");
          await this.writeData(record, bytes);
          const removal: Overlay = {
            path: oldPath,
            id: randomUUID(),
            kind: from.entry.kind,
            mode: mode(from.entry),
            size: 0,
            digest:
              "sha256:" +
              createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
            removed: true,
            dirty: true,
          };
          await this.persist({
            ...this.state,
            overlay: [
              ...this.state.overlay.filter(
                (entry) => entry.path !== oldPath && entry.path !== target,
              ),
              record,
              removal,
            ],
          });
          destination.overlay = record;
          await this.journal.mark(target);
          await this.journal.mark(oldPath, "remove");
          if (replaced) replaced.detached = true;
          for (const handle of this.handles.values())
            if (handle.node === from) handle.node = destination;
          this.paths.delete(oldPath);
          this.paths.set(target, destination);
          this.nodes.set(destination.inode, destination);
          from.detached = true;
          await this.reclaimData();
          return Buffer.alloc(0);
        });
      case op.ACCESS:
        await this.current(
          node.path,
          Boolean(body.readUInt32LE(0) & 2),
          signal,
        );
        return Buffer.alloc(0);
      case op.STATFS: {
        const result = Buffer.alloc(80);
        const total = Math.floor(this.descriptor.budgets.dirty_bytes / 4096);
        for (const offset of [0, 8, 16])
          result.writeBigUInt64LE(BigInt(total), offset);
        result.writeBigUInt64LE(BigInt(this.options.maxNodes ?? 100000), 24);
        result.writeBigUInt64LE(
          BigInt(
            Math.max(0, (this.options.maxNodes ?? 100000) - this.nodes.size),
          ),
          32,
        );
        result.writeUInt32LE(4096, 40);
        result.writeUInt32LE(255, 44);
        result.writeUInt32LE(4096, 48);
        return result;
      }
      default:
        fail("ENOSYS");
    }
  }
  private async respond(
    unique: bigint,
    payload: Buffer,
    error = 0,
  ): Promise<void> {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(16 + payload.length);
    header.writeInt32LE(-error, 4);
    header.writeBigUInt64LE(unique, 8);
    const output = Buffer.concat([header, payload]),
      device = this.device;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        if (!device || this.stopped) return;
        const written = writeSync(device.fd, output);
        if (written !== output.length)
          workspaceError("FUSE_WRITE_FAILED", "Incomplete FUSE response");
      });
    return this.writeQueue;
  }
  private async serve(): Promise<void> {
    const reader = new Worker(
      `const {workerData,parentPort}=require('node:worker_threads');const {readSync}=require('node:fs');const pause=new Int32Array(new SharedArrayBuffer(4));for(;;){const data=Buffer.alloc(256*1024);try{const count=readSync(workerData.fd,data,0,data.length,null);if(!count)break;parentPort.postMessage(data.subarray(0,count));}catch(error){if(error.code==='EAGAIN'){Atomics.wait(pause,0,0,10);continue;}if(error.code==='ENODEV'||error.code==='EBADF')break;throw error;}}`,
      { eval: true, execArgv: [], workerData: { fd: this.device!.fd } },
    );
    this.reader = reader;
    await new Promise<void>((resolve, reject) => {
      reader.on("message", (message: Uint8Array) => {
        const packet = Buffer.from(message),
          count = packet.length;
        if (count < 40 || packet.readUInt32LE(0) !== count) {
          reject(new Error("Invalid kernel request boundary"));
          return;
        }
        const opcode = packet.readUInt32LE(4),
          unique = packet.readBigUInt64LE(8),
          inode = packet.readBigUInt64LE(16);
        if (opcode === op.INTERRUPT) {
          const target =
            count >= 48
              ? this.requests.get(packet.readBigUInt64LE(40))
              : undefined;
          if (target) target.abort();
          else void this.respond(unique, Buffer.alloc(0), errno.EAGAIN);
          return;
        }
        if (this.requests.size >= (this.options.maxInflight ?? 32)) {
          void this.respond(unique, Buffer.alloc(0), errno.ENOSPC);
          return;
        }
        const controller = new AbortController();
        this.requests.set(unique, controller);
        this.metrics.requests++;
        void this.dispatch(
          opcode,
          inode,
          packet.subarray(40),
          controller.signal,
        )
          .then(async (result) => {
            if (result !== null) await this.respond(unique, result);
            if (opcode === op.INIT) this.readyResolve?.();
          })
          .catch(async (error) => {
            if (opcode === op.INIT) this.readyReject?.(error);
            await this.respond(unique, Buffer.alloc(0), errorNumber(error));
          })
          .finally(() => this.requests.delete(unique));
      });
      reader.once("error", reject);
      reader.once("exit", (code) =>
        code === 0 || this.stopped
          ? resolve()
          : reject(new Error("FUSE reader exited")),
      );
    });
  }
  async mount(): Promise<{
    state: "READY";
    profile: string;
    workspace_id: string;
    hydratedBytes: number;
  }> {
    const capability = await discoverVirtualHost(this.options.host);
    if (!capability.available)
      workspaceError(
        "VIRTUAL_FILESYSTEM_UNAVAILABLE",
        "Virtual filesystem unavailable: " +
          capability.reasons.join(",") +
          "; explicitly select SPARSE or MATERIALIZED",
      );
    await this.current();
    await this.load();
    await this.claimOwner();
    const escaped = path
      .resolve(this.options.mountpoint)
      .replaceAll(" ", "\\040");
    const prior = (await fs.readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .find((line) => line.split(" ")[4] === escaped);
    try {
      if (prior) {
        if (!prior.includes(" - " + VIRTUAL_FILESYSTEM_PROFILE.mountType + " "))
          workspaceError(
            "VIRTUAL_MOUNT_OCCUPIED",
            "Mountpoint belongs to another filesystem",
          );
        await fs.writeFile(
          `/sys/fs/fuse/connections/${prior.split(" ")[2]!.split(":")[1]}/abort`,
          "1",
        );
        await command(this.options.host.unmount.path, [
          "--",
          this.options.mountpoint,
        ]);
      }
      await fs.mkdir(this.options.mountpoint, { recursive: true, mode: 0o755 });
      if (
        (await fs.realpath(this.options.mountpoint)) !==
        path.resolve(this.options.mountpoint)
      )
        workspaceError(
          "VIRTUAL_MOUNT_UNSAFE",
          "Canonical mount directory required",
        );
      const directory = await fs.lstat(this.options.mountpoint);
      if (
        directory.uid !== process.getuid?.() ||
        directory.mode & 0o022 ||
        (await fs.readdir(this.options.mountpoint)).length
      )
        workspaceError(
          "VIRTUAL_MOUNT_OCCUPIED",
          "Virtual mountpoint must be an owned empty directory",
        );
    } catch (error) {
      await fs.unlink(this.ownerPath());
      this.ownsMount = false;
      throw error;
    }
    try {
      this.device = await fs.open(
        VIRTUAL_FILESYSTEM_PROFILE.device,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      await fs.unlink(this.ownerPath());
      this.ownsMount = false;
      throw error;
    }
    this.stopped = false;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    try {
      await command(
        this.options.host.mount.path,
        [
          "-i",
          "-t",
          "fuse",
          "-o",
          `subtype=hyperfide,fd=3,rootmode=40000,user_id=${this.options.uid},group_id=${this.options.gid},default_permissions`,
          "/dev/fuse",
          this.options.mountpoint,
        ],
        this.device.fd,
      );
      this.serving = this.serve();
      this.serving.catch((error) => this.readyReject?.(error));
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("FUSE initialization timed out")),
              10000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      return {
        state: "READY",
        profile: VIRTUAL_FILESYSTEM_PROFILE.id,
        workspace_id: this.descriptor.workspace_id,
        hydratedBytes: this.metrics.hydratedBytes,
      };
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }
  async prefetch(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{ files: number; bytes: number }> {
    if (paths.length > (this.options.maxOpenHandles ?? 128))
      workspaceError(
        "PREFETCH_BUDGET",
        "Prefetch exceeds the configured file budget",
      );
    let bytes = 0;
    for (const name of paths) {
      const node = await this.lookup(name, signal);
      if (node.entry.kind === "directory") fail("EISDIR");
      bytes += await this.size(node, signal);
      if (bytes > this.descriptor.budgets.materialized_bytes)
        workspaceError(
          "PREFETCH_BUDGET",
          "Prefetch exceeds the materialization byte budget",
        );
      await this.bytes(node, signal);
    }
    return { files: paths.length, bytes };
  }
  async checkpoint() {
    return this.exclusive(async () => {
      const before = await this.journal.snapshot();
      if (!before.pending) await this.current();
      const advancing = new NativeWorkspaceClient(
        {
          call: async <T>(
            action: string,
            input: Record<string, unknown>,
            options?: { operation_id?: string; signal?: AbortSignal },
          ): Promise<T> => {
            const result = await this.client.transport.call<T>(
              action,
              input,
              options,
            );
            if (
              action === "source.workspaces.checkpoint" ||
              (action === "source.operations.read" &&
                (result as { result?: unknown }).result)
            ) {
              const current = await this.client.detail(
                this.descriptor.workspace_id,
              );
              this.descriptor = current;
              this.state.binding = binding(current);
              this.state.descriptor = structuredClone(current);
              await this.persist();
            }
            return result;
          },
        },
        this.client.scope,
      );
      const result = await new NativeWorkspaceCheckpoint(
        advancing,
        this.journal,
        this.options.mountpoint,
      ).checkpoint(this.descriptor);
      this.descriptor = result.workspace;
      this.state.binding = binding(this.descriptor);
      this.state.descriptor = structuredClone(this.descriptor);
      this.state.overlay = this.state.overlay.map((record) => ({
        ...record,
        dirty: false,
      }));
      await this.persist();
      return result;
    });
  }
  async close(): Promise<void> {
    if (!this.device) {
      if (this.ownsMount) {
        await fs.unlink(this.ownerPath()).catch(() => {});
        this.ownsMount = false;
      }
      return;
    }
    for (const controller of this.requests.values()) controller.abort();
    try {
      await command(this.options.host.unmount.path, [
        "--",
        this.options.mountpoint,
      ]);
    } finally {
      this.stopped = true;
      await this.reader?.terminate();
      await this.serving;
      const device = this.device;
      this.device = undefined;
      await device.close();
      await fs.unlink(this.ownerPath()).catch(() => {});
      this.ownsMount = false;
    }
  }
}
