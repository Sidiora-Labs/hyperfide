import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SlicesProvider, providerId, type SliceManifest } from "./provider.ts";
import {
  installSlicesEnvironment,
  selectRepositoryEnvironment,
} from "../../packages/bundled-plugins/environment-slices.ts";
import type { TaskLifecycle } from "./projected-lifecycle.ts";

const binary = resolve(process.env.HYPERFIDE_BINARY ?? "./cg");
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
    let registration:
      | Parameters<TaskLifecycle["experimental_environments"]["register"]>[0]
      | undefined;
    let finish: Parameters<TaskLifecycle["onThreadFinished"]>[0] | undefined;
    let detail: Parameters<TaskLifecycle["registerTaskDetail"]>[1] | undefined;
    let publish:
      | Parameters<TaskLifecycle["registerPublication"]>[1]
      | undefined;
    const worktree = join(home, "published");
    let publications = 0;
    installSlicesEnvironment(
      {
        experimental_environments: {
          register: (value) => {
            registration = value;
          },
        },
        onThreadFinished: (value) => {
          finish = value;
        },
        registerTaskDetail: (_id, value) => {
          detail = value;
        },
        registerPublication: (_id, value) => {
          publish = value;
        },
      },
      {
        binary,
        dataDir: join(home, "data"),
        publication: {
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
        },
      },
    );
    assert(registration && finish && detail && publish);
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
    await registration.remove({ resource: { sliceId: id } });
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
