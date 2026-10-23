import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SlicesProvider, providerId, type SliceManifest } from "./provider.ts";
import {
  installSlicesEnvironment,
  selectRepositoryEnvironment,
} from "../../packages/bundled-plugins/environment-slices.ts";
import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { createSliceHandlers } from "./host.ts";
import { sliceInputs } from "./contract.ts";
type Registration = {
  id: string;
  inputs: typeof sliceInputs;
  create(
    context: unknown,
  ): Promise<{ path: string; resource: { sliceId: string } }>;
  remove(context: unknown): Promise<unknown>;
};

// The platform test run starts each package in its own directory, so the binary under test is the
// repository's own `cg` resolved from this file unless HYPERFIDE_BINARY names another one.
const binary = process.env.HYPERFIDE_BINARY
  ? resolve(process.env.HYPERFIDE_BINARY)
  : fileURLToPath(new URL("../../../cg", import.meta.url));
test("real snapshots: create, isolated edit, thread finish, restart, discard and publication", async () => {
  const home = await mkdtemp(join(tmpdir(), "hyperfide-slices-"));
  const repo = join(home, "repository");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
  const run = (...args: string[]) =>
    execFileSync(binary, args, { cwd: repo, encoding: "utf8" });
  try {
    await mkdir(join(repo, "spec", "fixture"), { recursive: true });
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(
      join(repo, "src", "remove.ts"),
      "export const removed = 1;\n",
    );
    await writeFile(join(repo, "outside.txt"), "keep outside slice\n");
    await writeFile(
      join(repo, "spec", "workflow.kvx"),
      '[meta]\nactive_feature = "fixture"\n[hierarchy]\nmain = "main"\n',
    );
    await writeFile(
      join(repo, "spec", "fixture", "spec.kvx"),
      '[meta]\nfeature = "fixture"\n[task.1]\nwave = 1\nstatus = "pending"\ntouches = ["src/"]\n[task.2]\nwave = 1\nstatus = "pending"\ntouches = ["src/**"]\n',
    );
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@hyperfide.dev",
      "commit",
      "-qm",
      "Fixture",
    );
    run("init", "--nested");
    run("commit", "-m", "Initial snapshot");
    const gitHead = git(repo, "rev-parse", "HEAD");
    const manifest: SliceManifest = JSON.parse(
      run("slice", "1", "-f", "fixture", "--json"),
    );
    const fullManifest: SliceManifest = JSON.parse(
      run("slice", "2", "-f", "fixture", "--json"),
    );
    assert.equal(manifest.mode, "SLICE");
    assert.equal(fullManifest.mode, "FULL_TREE");
    const base = JSON.parse(run("log", "-n", "1", "--json")).commits[0].id;
    // Preparation above uses the existing slice CLI. Every provider command below
    // runs with Git unavailable, including the binary's optional Git probes.
    const service = new SlicesProvider(binary, join(home, "data"));
    let registration!: Registration;
    let idle!: (event: { thread: { id: string } }) => Promise<void>;
    let getDetail!: (input: {
      threadId: string;
    }) => Promise<{ sliceId: string; snapshotChain: string[] }>;
    const handlers = createSliceHandlers(binary, join(home, "data"));
    const storage = new Map();
    const api = {
      experimental_environments: {
        register(value: Registration) {
          registration = value;
        },
      },
      hosts: {
        experimental_client() {
          return {
            async call(method: keyof typeof handlers, input: never) {
              return handlers[method](input);
            },
          };
        },
      },
      storage: {
        kv: {
          async get(key: string) {
            return storage.get(key);
          },
          async set(key: string, value: unknown) {
            storage.set(key, value);
          },
          async delete(key: string) {
            storage.delete(key);
          },
        },
      },
      events: {
        on(name: string, handler: typeof idle) {
          assert.equal(name, "thread.idle");
          idle = handler;
        },
      },
      rpc: {
        register(_contract: unknown, methods: { detail: typeof getDetail }) {
          getDetail = methods.detail;
        },
      },
    };
    installSlicesEnvironment(api as unknown as HyperfidePluginApi);
    const finish = async (_id: string) => idle({ thread: { id: "thread-1" } });
    const detail = async (_id: string) => getDetail({ threadId: "thread-1" });
    const worktree = join(home, "published");
    let publications = 0;
    const publish = (id: string, target: string) =>
      service.publish(id, target, {
        async publish(input) {
          publications++;
          assert.equal(input.worktree, worktree);
          assert.match(input.snapshot, /^[a-f0-9]{64}$/);
          git(repo, "worktree", "add", "-qb", "publication", worktree);
          for (const file of input.deleted) await rm(join(worktree, file));
          for (const file of input.paths) {
            await mkdir(join(worktree, file, ".."), { recursive: true });
            await cp(join(input.source, file), join(worktree, file));
          }
        },
      });
    assert.equal(registration.id, providerId);
    assert("issues" in registration.inputs["~standard"].validate(null));
    assert(
      "value" in
        registration.inputs["~standard"].validate({ task: "1", manifest }),
    );
    assert.equal(
      selectRepositoryEnvironment({}, "hyperfide-worktree"),
      "hyperfide-worktree",
    );
    assert.equal(
      selectRepositoryEnvironment(
        { environmentProviderId: providerId },
        "hyperfide-worktree",
      ),
      providerId,
    );
    const created = await registration.create({
      host: { id: "fixture-host" },
      signal: new AbortController().signal,
      projectCheckout: { path: repo },
      thread: { id: "thread-1" },
      pathKey: "attempt-1",
      inputs: { task: "1", manifest },
    });
    const id = created.resource.sliceId;
    const initial = await service.load(id);
    assert.equal(initial.baseSnapshot, base);
    await assert.rejects(readFile(join(created.path, "outside.txt")), /ENOENT/);
    await assert.rejects(readFile(join(created.path, ".git")), /ENOENT/);
    await writeFile(
      join(created.path, "src", "main.ts"),
      "export const value = 2;\n",
    );
    await rm(join(created.path, "src", "remove.ts"));
    await writeFile(
      join(created.path, "src", "added.ts"),
      "export const added = 3;\n",
    );
    await finish(id);
    installSlicesEnvironment(api as unknown as HyperfidePluginApi);
    await idle({ thread: { id: "unrelated-thread" } });
    const shown = await detail(id);
    assert.equal(shown.sliceId, id);
    assert.equal(shown.snapshotChain[0], base);
    assert.equal(shown.snapshotChain.length, initial.snapshots.length + 1);
    await finish(id);
    assert.deepEqual((await detail(id)).snapshotChain, shown.snapshotChain);
    assert.equal(
      (
        await new SlicesProvider(binary, join(home, "data")).load(id)
      ).snapshots.at(-1),
      shown.snapshotChain.at(-1),
    );
    assert.equal(
      await readFile(join(repo, "src", "main.ts"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(
      JSON.parse(run("log", "-n", "1", "--json")).commits[0].id,
      base,
    );
    await writeFile(join(created.path, "escape.txt"), "out of scope");
    await assert.rejects(finish(id), /outside slice/);
    await rm(join(created.path, "escape.txt"));
    const { symlink } = await import("node:fs/promises");
    await symlink(join(repo, "outside.txt"), join(created.path, "src", "link"));
    await assert.rejects(finish(id), /Symlink/);
    await rm(join(created.path, "src", "link"));
    await publish(id, worktree);
    assert.equal(publications, 1);
    assert.equal(
      await readFile(join(worktree, "src", "main.ts"), "utf8"),
      "export const value = 2;\n",
    );
    assert.equal(
      await readFile(join(worktree, "outside.txt"), "utf8"),
      "keep outside slice\n",
    );
    await assert.rejects(
      readFile(join(worktree, "src", "remove.ts")),
      /ENOENT/,
    );
    assert.equal(git(repo, "rev-parse", "HEAD"), gitHead);
    const full = await service.create({
      repository: repo,
      task: "2",
      thread: "full",
      manifest: fullManifest,
    });
    assert.equal(
      await readFile(join(full.path, "outside.txt"), "utf8"),
      "keep outside slice\n",
    );
    assert((await service.load(full.id)).manifest.fallback_reason);
    await service.discard(full.id);
    await registration.remove({
      hostId: "fixture-host",
      signal: new AbortController().signal,
      resource: { sliceId: id, threadId: "thread-1" },
    });
    assert.equal(await getDetail({ threadId: "thread-1" }), null);
    await assert.rejects(service.load(id), /ENOENT/);
    await assert.rejects(service.discard("../repository"), /Invalid slice/);
    await assert.rejects(
      service.create({
        repository: repo,
        task: "1",
        thread: "bad",
        manifest: { ...manifest, included_paths: ["../escape"] },
      }),
      /Unsafe/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
