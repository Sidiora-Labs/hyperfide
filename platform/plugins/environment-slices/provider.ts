import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

const execute = promisify(execFile);
export const providerId = "hyperfide-environment-slices";
export interface SliceManifest {
  kind: "hyperfide.workspace-slice";
  mode: "SLICE" | "FULL_TREE";
  fallback_reason: string | null;
  digest: string;
  included_paths: string[];
  build_roots: string[];
  metadata_roots: string[];
}
export interface SliceState {
  id: string;
  repository: string;
  path: string;
  manifest: SliceManifest;
  baseSnapshot: string;
  snapshots: string[];
}
export interface Publication {
  // The wave publication service owns closure checks and permission to push.
  publish(input: {
    source: string;
    snapshot: string;
    worktree: string;
    paths: string[];
    deleted: string[];
  }): Promise<void>;
}
const safePath = (path: string) => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (p) => p === "." || p === ".." || p === ".git" || p === ".codegraph",
      )
  )
    throw new Error(`Unsafe slice path: ${path}`);
  return path.replace(/\/$/, "");
};
export class SlicesProvider {
  readonly binary: string;
  readonly dataDir: string;

  constructor(binary: string, dataDir: string) {
    this.binary = binary;
    this.dataDir = dataDir;
    if (!binary.startsWith("/"))
      throw new Error("The Hyperfide binary path must be absolute");
  }
  private async run(path: string, args: string[]) {
    return (
      await execute(this.binary, args, {
        cwd: path,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PATH: "" },
      })
    ).stdout;
  }
  private location(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid slice id");
    return join(resolve(this.dataDir), "slices", id);
  }
  private async save(state: SliceState) {
    const file = join(this.location(state.id), "state.json");
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${file}.tmp`, file);
  }
  async load(id: string): Promise<SliceState> {
    const state: SliceState = JSON.parse(
      await readFile(join(this.location(id), "state.json"), "utf8"),
    );
    if (state.id !== id || state.path !== join(this.location(id), "tree"))
      throw new Error("Invalid slice state");
    return state;
  }
  async files(path: string, prefix = ""): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(join(path, prefix), {
      withFileTypes: true,
    })) {
      if (entry.name === ".codegraph" || entry.name === ".git") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlink in slice: ${name}`);
      if (entry.isDirectory()) result.push(...(await this.files(path, name)));
      else if (entry.isFile()) result.push(name);
    }
    return result;
  }
  private allows(manifest: SliceManifest, path: string) {
    return (
      manifest.mode === "FULL_TREE" ||
      [
        ...manifest.included_paths,
        ...manifest.build_roots,
        ...manifest.metadata_roots,
      ].some(
        (root) =>
          path === safePath(root) || path.startsWith(`${safePath(root)}/`),
      )
    );
  }
  private async enforce(state: SliceState, prune: boolean) {
    for (const file of await this.files(state.path)) {
      if (!this.allows(state.manifest, file)) {
        if (!prune) throw new Error(`Edit outside slice: ${file}`);
        await rm(join(state.path, file));
      }
    }
  }
  async create(input: {
    repository: string;
    task: string;
    thread: string;
    manifest: SliceManifest;
    snapshot?: string;
  }): Promise<SliceState> {
    const manifest = structuredClone(input.manifest);
    if (
      manifest.kind !== "hyperfide.workspace-slice" ||
      !["SLICE", "FULL_TREE"].includes(manifest.mode) ||
      (manifest.mode === "FULL_TREE") !== Boolean(manifest.fallback_reason)
    )
      throw new Error("Invalid slice manifest");
    for (const path of [
      ...manifest.included_paths,
      ...manifest.build_roots,
      ...manifest.metadata_roots,
    ])
      safePath(path);
    const repository = resolve(input.repository);
    const log = JSON.parse(
      await this.run(repository, ["log", "-n", "1", "--json"]),
    );
    const snapshot: string = input.snapshot ?? log.commits[0]?.id;
    if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot))
      throw new Error("Record a repository snapshot before creating a slice");
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          repository,
          input.task,
          input.thread,
          snapshot,
          manifest.digest,
        ]),
      )
      .digest("hex");
    const home = this.location(id);
    await mkdir(dirname(home), { recursive: true });
    await mkdir(home); // Never overwrite another live thread's environment.
    const path = join(home, "tree");
    try {
      await mkdir(path);
      await this.run(path, ["init", "--nested"]);
      await cp(
        join(repository, ".codegraph", "objects"),
        join(path, ".codegraph", "objects"),
        { recursive: true },
      );
      await this.run(path, ["checkout", snapshot, "--force"]);
      const state: SliceState = {
        id,
        repository,
        path,
        manifest,
        baseSnapshot: snapshot,
        snapshots: [snapshot],
      };
      await this.enforce(state, true);
      await this.run(path, ["commit", "-m", `Create slice ${id}`]);
      const baseline = JSON.parse(
        await this.run(path, ["log", "-n", "1", "--json"]),
      ).commits[0].id;
      if (baseline !== snapshot) state.snapshots.push(baseline);
      await this.save(state);
      return state;
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }
  async finish(id: string, message = "Thread finished"): Promise<SliceState> {
    const state = await this.load(id);
    await this.enforce(state, false);
    await this.run(state.path, ["commit", "-m", message]);
    const head: string = JSON.parse(
      await this.run(state.path, ["log", "-n", "1", "--json"]),
    ).commits[0].id;
    if (state.snapshots.at(-1) !== head) state.snapshots.push(head);
    await this.save(state);
    return state;
  }
  async discard(id: string) {
    await this.load(id);
    await rm(this.location(id), { recursive: true, force: true });
  }
  async publish(id: string, worktree: string, publication: Publication) {
    const state = await this.finish(id, "Publication snapshot");
    // Compare against the original snapshot in a separate tree to include deletions.
    const base = join(this.location(id), "publication-base");
    await mkdir(base);
    try {
      await this.run(base, ["init", "--nested"]);
      await cp(
        join(state.path, ".codegraph", "objects"),
        join(base, ".codegraph", "objects"),
        { recursive: true },
      );
      await this.run(base, ["checkout", state.baseSnapshot, "--force"]);
      const original = (await this.files(base)).filter((file) =>
        this.allows(state.manifest, file),
      );
      await this.run(base, ["checkout", state.snapshots.at(-1)!, "--force"]);
      const paths = await this.files(base);
      const deleted = original.filter((file) => !paths.includes(file));
      await publication.publish({
        source: base,
        snapshot: state.snapshots.at(-1)!,
        worktree: resolve(worktree),
        paths,
        deleted,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}
