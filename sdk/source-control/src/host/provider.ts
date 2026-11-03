import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createSignedSourceClient } from "../signed.js";
import {
  NativeWorkspaceClient,
  repositoryPath,
  withinScope,
  type WorkspaceDescriptor,
} from "./client.js";
import { NativeObjectCache } from "./cache.js";
import { SourceWorkspaceJournal } from "./journal.js";
import { SparseSourceMaterializer } from "./materializer.js";
import { NativeWorkspaceCheckpoint } from "./checkpoint.js";
import { NativeVirtualFilesystem } from "./virtual-filesystem.js";
import {
  discoverVirtualHost,
  VIRTUAL_FILESYSTEM_PROFILE,
  type VirtualHostConfiguration,
} from "./capabilities.js";

import { NATIVE_SOURCE_ENVIRONMENT_ID as nativeProviderId, type NativeSliceInput } from "../environment.js";

interface NativeState {
  schema_version: 1;
  id: string;
  input: NativeSliceInput;
  descriptor: WorkspaceDescriptor;
  path: string;
  snapshots: string[];
  cacheCounters?: NativeObjectCache["metrics"];
}
async function privateJSON(filename: string): Promise<any> {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename)
    throw new Error(
      "An absolute private source configuration path is required",
    );
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 1024 * 1024 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error(
        "Source configuration must be a private owned regular file",
      );
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
class VirtualDaemon {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  alive = true;
  constructor(readonly child: ChildProcess) {
    child.on("message", (value: any) => {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      value.error
        ? pending.reject(
            Object.assign(new Error(value.error.message), {
              code: value.error.code,
            }),
          )
        : pending.resolve(value.result);
    });
    const failed = () => {
      this.alive = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Virtual source daemon exited"));
      }
      this.pending.clear();
    };
    child.once("error", failed);
    child.once("exit", failed);
  }
  request(action: "checkpoint" | "close" | "metrics") {
    if (!this.alive)
      return Promise.reject(new Error("Virtual source daemon is unavailable"));
    return new Promise<any>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Object.assign(
            new Error(
              "Virtual operation is unresolved; retry to reconcile its journal",
            ),
            { code: "VIRTUAL_OUTCOME_UNKNOWN" },
          ),
        );
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send!({ id, action });
    });
  }
  checkpoint() {
    return this.request("checkpoint");
  }
  metrics() {
    return this.request("metrics");
  }
  async close() {
    await this.request("close");
    this.alive = false;
  }
}
export class NativeSlicesProvider {
  private static readonly virtuals = new Map<string, VirtualDaemon>();
  constructor(readonly dataDir: string) {}
  private location(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id))
      throw new Error("Invalid native workspace resource");
    return path.join(path.resolve(this.dataDir), "native-source", id);
  }
  private async save(state: NativeState): Promise<void> {
    const file = path.join(this.location(state.id), "state.json"),
      temporary = file + ".tmp-" + randomUUID();
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  }
  private async load(id: string): Promise<NativeState> {
    const state = (await privateJSON(
      path.join(this.location(id), "state.json"),
    )) as NativeState;
    if (
      state.schema_version !== 1 ||
      state.id !== id ||
      state.path !== path.join(this.location(id), "source")
    )
      throw new Error("Invalid retained native workspace");
    return state;
  }
  private async runtime(state: Pick<NativeState, "id" | "input" | "path">) {
    const configuration = await privateJSON(state.input.sourceConfigFile);
    const sdk = await createSignedSourceClient(
      configuration.transport ?? configuration,
    );
    const authority = configuration.assignment?.authority;
    if (
      configuration.assignment &&
      configuration.assignment.workspace_id !== state.input.workspaceId
    )
      throw new Error(
        "Source configuration belongs to another assigned workspace",
      );
    const client = new NativeWorkspaceClient(
      {
        call: <T>(
          action: string,
          input: Record<string, unknown>,
          options = {},
        ) =>
          sdk.call<T>(action as never, input, {
            ...options,
            ...(authority ? { authority } : {}),
          }),
      },
      sdk.scope,
    );
    const descriptor = await client.detail(state.input.workspaceId);
    if (descriptor.mode !== state.input.mode)
      throw new Error("Requested mode differs from the admitted workspace");
    const cache = new NativeObjectCache(
      path.join(this.location(state.id), "cache"),
      {
        max_bytes: descriptor.budgets.cache_bytes,
        max_entries: descriptor.budgets.max_cache_entries,
        max_object_bytes: descriptor.budgets.max_file_bytes + 65536,
      },
    );
    const journal = new SourceWorkspaceJournal(
      path.join(this.location(state.id), "journal"),
    );
    const materializer = new SparseSourceMaterializer(
      client,
      cache,
      journal,
      state.path,
    );
    return { client, descriptor, cache, journal, materializer };
  }
  async capabilities() {
    const configurationPath = process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG;
    if (!configurationPath)
      return {
        profile: VIRTUAL_FILESYSTEM_PROFILE.id,
        available: false,
        reasons: ["VIRTUAL_HOST_CONFIGURATION_REQUIRED"],
        fallback: {
          modes: ["SPARSE", "MATERIALIZED"] as ("SPARSE" | "MATERIALIZED")[],
          requiresExplicitSelection: true as const,
        },
      };
    const host = (await privateJSON(
      configurationPath,
    )) as VirtualHostConfiguration;
    const discovered = await discoverVirtualHost(host);
    return {
      profile: discovered.profile.id,
      available: discovered.available,
      reasons: discovered.reasons,
      fallback: discovered.fallback,
    };
  }
  async mountDaemon(state: NativeState): Promise<NativeVirtualFilesystem> {
    const runtime = await this.runtime(state);
    const configurationPath = process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG;
    if (!configurationPath)
      throw new Error(
        "VIRTUAL_FILESYSTEM_UNAVAILABLE: a pinned HYPERFIDE_VIRTUAL_HOST_CONFIG is required; explicitly select SPARSE or MATERIALIZED",
      );
    const host = (await privateJSON(
      configurationPath,
    )) as VirtualHostConfiguration;
    const capabilities = await discoverVirtualHost(host);
    if (!capabilities.available)
      throw new Error(
        "VIRTUAL_FILESYSTEM_UNAVAILABLE: " +
          capabilities.reasons.join(",") +
          "; explicitly select SPARSE or MATERIALIZED",
      );
    const mounted = new NativeVirtualFilesystem(
      runtime.client,
      runtime.cache,
      runtime.journal,
      runtime.descriptor,
      {
        mountpoint: state.path,
        stateDirectory: path.join(this.location(state.id), "overlay"),
        host,
        uid: process.getuid!(),
        gid: process.getgid!(),
      },
    );
    await mounted.mount();
    return mounted;
  }
  private async virtual(
    state: NativeState,
    _runtime: Awaited<ReturnType<NativeSlicesProvider["runtime"]>>,
  ): Promise<VirtualDaemon> {
    const existing = NativeSlicesProvider.virtuals.get(this.location(state.id));
    if (existing?.alive) return existing;
    const loader = `const input=new Promise(resolve=>process.once('message',resolve));const mod=await import(${JSON.stringify(import.meta.url)});await mod.serveNativeVirtualDaemon(await input);`;
    const inherited = import.meta.url.endsWith(".ts")
      ? ["--import", import.meta.resolve("tsx")]
      : [];
    const child = spawn(
      process.execPath,
      [...inherited, "--input-type=module", "-e", loader],
      {
        cwd: "/",
        env: process.env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    child.stderr?.on("data", () => {});
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Virtual daemon startup timed out"));
      }, 30000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Virtual daemon exited during startup"));
      });
      child.on("message", (value: any) => {
        if (value.ready === true) {
          clearTimeout(timer);
          resolve();
        } else if (value.error) {
          clearTimeout(timer);
          reject(new Error(value.error.message));
        }
      });
    });
    child.send!({ dataDir: this.dataDir, state });
    await started;
    const mounted = new VirtualDaemon(child);
    NativeSlicesProvider.virtuals.set(this.location(state.id), mounted);
    return mounted;
  }
  async create(
    input: NativeSliceInput,
    thread: string,
  ): Promise<{ sliceId: string; path: string }> {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          nativeProviderId,
          thread,
          input.sourceConfigFile,
          input.workspaceId,
        ]),
      )
      .digest("hex");
    const directory = this.location(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(directory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      root.mode & 0o077 ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("Unsafe native workspace state directory");
    const pending = { id, input, path: path.join(directory, "source") };
    const runtime = await this.runtime(pending);
    const state: NativeState = {
      schema_version: 1,
      ...pending,
      descriptor: runtime.descriptor,
      snapshots: [runtime.descriptor.base_revision_id],
    };
    const readPaths = input.readPaths ?? runtime.descriptor.read_paths;
    for (const item of readPaths) {
      if (item !== "") repositoryPath(item);
      if (!withinScope(item, runtime.descriptor.read_paths))
        throw new Error("Selected path exceeds the admitted native read scope");
    }
    state.descriptor = runtime.descriptor;
    state.snapshots = [runtime.descriptor.base_revision_id];
    try {
      const previous = await this.load(id);
      if (
        JSON.stringify(previous.input) !== JSON.stringify(input) ||
        previous.descriptor.workspace_id !== runtime.descriptor.workspace_id
      )
        throw new Error(
          "Native workspace resource has another immutable binding",
        );
      if (input.mode === "VIRTUAL") await this.virtual(previous, runtime);
      return { sliceId: id, path: previous.path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (input.mode === "VIRTUAL") await this.virtual(state, runtime);
    else await runtime.materializer.materialize(runtime.descriptor, readPaths);
    state.cacheCounters = runtime.cache.metrics;
    await this.save(state);
    return { sliceId: id, path: state.path };
  }
  private accumulate(state: NativeState, cache: NativeObjectCache): void {
    const next = cache.metrics;
    for (const name of Object.keys(next) as (keyof typeof next)[])
      next[name] = Math.min(
        Number.MAX_SAFE_INTEGER,
        next[name] + (state.cacheCounters?.[name] ?? 0),
      );
    state.cacheCounters = next;
  }
  async metrics(id: string) {
    const state = await this.load(id);
    await this.runtime(state);
    const scan = async (directory: string, cacheOnly = false) => {
      let files = 0,
        bytes = 0,
        visited = 0,
        complete = true;
      const walk = async (folder: string): Promise<void> => {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(folder, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const item of entries) {
          if (++visited > 100000) {
            complete = false;
            return;
          }
          const filename = path.join(folder, item.name);
          if (item.isDirectory()) await walk(filename);
          else if (!cacheOnly || /^[0-9a-f]{64}\.data$/.test(item.name)) {
            const stat = await fs.lstat(filename);
            files++;
            bytes += stat.size;
          }
        }
      };
      await walk(directory);
      return { files, bytes, complete };
    };
    const journal = await new SourceWorkspaceJournal(
      path.join(this.location(id), "journal"),
    ).snapshot();
    const daemon = NativeSlicesProvider.virtuals.get(this.location(id));
    const current = daemon?.alive ? await daemon.metrics() : null;
    return {
      workspace_id: state.input.workspaceId,
      mode: state.input.mode,
      cache: {
        ...(await scan(path.join(this.location(id), "cache"), true)),
        counters:
          state.input.mode === "VIRTUAL"
            ? (current?.cache ?? null)
            : (state.cacheCounters ?? null),
        counter_scope:
          state.input.mode === "VIRTUAL"
            ? ("current_daemon" as const)
            : ("persisted_operations" as const),
      },
      materialized:
        state.input.mode === "VIRTUAL" ? null : await scan(state.path),
      dirty: {
        journal_paths: journal.entries.length,
        pending_checkpoint: journal.pending !== null,
      },
      virtual: current?.virtual ?? null,
    };
  }
  async finish(id: string) {
    const state = await this.load(id),
      runtime = await this.runtime(state);
    if (state.input.mode !== "VIRTUAL")
      await runtime.materializer.reconcile(runtime.descriptor);
    const journal = await runtime.journal.snapshot();
    if (!journal.entries.length && !journal.overflow && !journal.pending) {
      this.accumulate(state, runtime.cache);
      await this.save(state);
      return this.detail(id);
    }
    const result =
      state.input.mode === "VIRTUAL"
        ? await (await this.virtual(state, runtime)).checkpoint()
        : await new NativeWorkspaceCheckpoint(
            runtime.client,
            runtime.journal,
            state.path,
            runtime.materializer,
          ).checkpoint(runtime.descriptor);
    this.accumulate(state, runtime.cache);
    state.descriptor = result.workspace;
    if (!state.snapshots.includes(result.revision_id))
      state.snapshots.push(result.revision_id);
    await this.save(state);
    return this.detail(id);
  }
  async detail(id: string) {
    const state = await this.load(id);
    return {
      sliceId: id,
      snapshotChain: state.snapshots,
      fallbackReason: null,
    };
  }
  private async unmountInactive(
    state: NativeState,
    ownedChild?: ChildProcess,
  ): Promise<void> {
    const mounted = async () =>
      (await fs.readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .find(
          (line) =>
            line
              .split(" ")[4]
              ?.replace(/\\([0-7]{3})/g, (_m, n) =>
                String.fromCharCode(parseInt(n, 8)),
              ) === state.path,
        );
    const row = await mounted();
    if (!row) return;
    if (!row.includes(" - " + VIRTUAL_FILESYSTEM_PROFILE.mountType + " "))
      throw new Error("Native workspace path belongs to another mount");
    const ownerFile = path.join(
      this.location(state.id),
      "overlay",
      "owner.json",
    );
    const owner = await privateJSON(ownerFile);
    if (
      owner.workspace_id !== state.input.workspaceId ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !/^[0-9]+$/.test(owner.start)
    )
      throw new Error("Invalid virtual daemon ownership receipt");
    try {
      const processState = (
        await fs.readFile(`/proc/${owner.pid}/stat`, "utf8")
      )
        .split(") ")[1]!
        .split(" ");
      if (processState[19] === owner.start && processState[0] !== "Z") {
        if (!ownedChild || ownedChild.pid !== owner.pid)
          throw new Error("Another active daemon owns the native workspace");
        ownedChild.kill("SIGTERM");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const connection = row.split(" ")[2]?.split(":")[1];
    if (!connection || !/^[0-9]+$/.test(connection))
      throw new Error("Invalid kernel FUSE connection identity");
    const profile = process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG;
    if (!profile)
      throw new Error(
        "Pinned virtual host configuration is required for cleanup",
      );
    const host = (await privateJSON(profile)) as VirtualHostConfiguration;
    if (!(await discoverVirtualHost(host)).available)
      throw new Error("Virtual cleanup host configuration is unavailable");
    await fs.writeFile(`/sys/fs/fuse/connections/${connection}/abort`, "1");
    try {
      await promisify(execFile)(host.unmount.path, ["--", state.path], {
        timeout: 10000,
        maxBuffer: 8192,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      });
    } catch (error) {
      if (await mounted()) throw error;
    }
    if (await mounted())
      throw new Error("Native workspace is still mounted after cleanup");
    await fs.rm(ownerFile, { force: true });
  }
  async detach(id: string) {
    const state = await this.load(id);
    const key = this.location(id),
      daemon = NativeSlicesProvider.virtuals.get(key);
    if (daemon?.alive) {
      try {
        await daemon.close();
      } catch {
        await this.unmountInactive(state, daemon.child);
      }
    }
    await this.unmountInactive(state, daemon?.child);
    NativeSlicesProvider.virtuals.delete(key);
    return {
      sliceId: id,
      snapshotChain: state.snapshots,
      fallbackReason: null,
    };
  }
  async discard(id: string): Promise<void> {
    await this.detach(id);
    await fs.rm(this.location(id), { recursive: true, force: false });
  }
}

export async function serveNativeVirtualDaemon(input: {
  dataDir: string;
  state: NativeState;
}): Promise<void> {
  let mounted: NativeVirtualFilesystem;
  try {
    mounted = await new NativeSlicesProvider(input.dataDir).mountDaemon(
      input.state,
    );
  } catch (error) {
    process.send?.({
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.disconnect?.();
    return;
  }
  process.send?.({ ready: true });
  process.on("message", async (message: any) => {
    try {
      if (message.action === "metrics")
        process.send?.({
          id: message.id,
          result: {
            virtual: { ...mounted.metrics },
            cache: mounted.cache.metrics,
          },
        });
      else if (message.action === "checkpoint")
        process.send?.({ id: message.id, result: await mounted.checkpoint() });
      else if (message.action === "close") {
        await mounted.close();
        process.send?.({ id: message.id, result: { closed: true } });
        process.disconnect?.();
      }
    } catch (error) {
      process.send?.({
        id: message.id,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code,
        },
      });
    }
  });
  process.once("disconnect", () => {
    void mounted.close().catch(() => {});
  });
}
