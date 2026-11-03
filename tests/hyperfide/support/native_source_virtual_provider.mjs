import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";
import { SourceMetadata } from "../../../core/control-plane/dist/source_control/metadata.js";
import { createSignedSourceClient } from "../../../core/authority-client/src/index.ts";
import { NativeWorkspaceClient } from "../../../core/host-daemon/src/source-control/client.ts";
import { NativeSlicesProvider } from "../../../plugins/environment-slices/native-provider.ts";

export async function runNativeVirtualProvider({ config, directory }) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await new SourceMetadata(pool).registerRepository(config.scope, {
      authority_epoch: "1",
      policy_version: "signed-transport-v1",
      durability_profile: "single-region-verified-s3-v1",
    });
  } finally {
    await pool.end();
  }
  const sdk = await createSignedSourceClient(config),
    client = new NativeWorkspaceClient(
      { call: (action, input, options) => sdk.call(action, input, options) },
      config.scope,
    );
  const file = await client.putFile(Buffer.from("native provider base\n"));
  const empty = await sdk.call("source.objects.put", {
    kind: "tree-leaf",
    payload_base64: Buffer.from('[1,"",[]]').toString("base64"),
  });
  const tree = await sdk.call("source.trees.patch", {
    tree_id: empty.object_id,
    patches: [
      {
        path: "src/sample.txt",
        operation: "put",
        kind: "file",
        mode: "100644",
        object_id: file,
      },
    ],
  });
  const operation = randomUUID(),
    revision = await sdk.createRevision(
      {
        change_id: randomUUID(),
        root_tree_id: tree.root_tree_id,
        parent_revision_ids: [],
        predecessor_revision_ids: [],
        provenance: {
          author: {
            name: "Native provider qualification",
            email: "native-provider@example.invalid",
          },
          message: "Native provider source",
          timestamp: new Date().toISOString(),
        },
      },
      { operation_id: operation, idempotency_key: operation },
    );
  const root = await fs.mkdtemp(path.join(directory, "native-provider-")),
    configPath = path.join(root, "source.json"),
    hostPath = path.join(root, "host.json");
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const hash = (bytes) =>
    "sha256:" + createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(
    hostPath,
    JSON.stringify({
      mount: {
        path: "/usr/bin/mount",
        sha256: hash(await fs.readFile("/usr/bin/mount")),
      },
      unmount: {
        path: "/usr/bin/umount",
        sha256: hash(await fs.readFile("/usr/bin/umount")),
      },
    }),
    { mode: 0o600 },
  );
  const previous = process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG;
  process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG = hostPath;
  const provider = new NativeSlicesProvider(path.join(root, "provider")),
    receipts = [];
  try {
    assert.equal((await provider.capabilities()).available, true);
    for (const mode of ["SPARSE", "VIRTUAL"]) {
      const descriptor = await client.open({
        base_revision_id: revision.revision_id,
        mode,
        read_paths: ["src"],
        write_paths: ["src"],
      });
      const input = {
        sourceConfigFile: configPath,
        workspaceId: descriptor.workspace_id,
        mode,
      };
      if (mode === "SPARSE") {
        const hostile = createHash("sha256")
          .update(
            JSON.stringify([
              "hyperfide-native-source",
              "unsafe",
              configPath,
              descriptor.workspace_id,
            ]),
          )
          .digest("hex");
        const outside = path.join(root, "outside");
        await fs.mkdir(outside);
        await fs.mkdir(path.join(root, "provider", "native-source"), {
          recursive: true,
        });
        const alias = path.join(root, "provider", "native-source", hostile);
        await fs.symlink(outside, alias);
        await assert.rejects(
          provider.create(input, "unsafe"),
          /Unsafe native workspace state/,
        );
        assert.deepEqual(await fs.readdir(outside), []);
        await fs.unlink(alias);
      }
      const created = await provider.create(input, mode);
      let primaryFailure;
      try {
        assert.equal(
          await fs.readFile(path.join(created.path, "src/sample.txt"), "utf8"),
          "native provider base\n",
        );
        const measured = await provider.metrics(created.sliceId);
        assert(measured.cache.files > 0);
        assert(measured.cache.bytes > 0);
        assert(measured.cache.counters.downloads > 0);
        if (mode === "SPARSE") assert(measured.materialized.files > 0);
        else {
          assert.equal(measured.materialized, null);
          assert(measured.virtual.requests > 0);
        }
        await fs.writeFile(
          path.join(created.path, "src/sample.txt"),
          mode + " private edit\n",
        );
        const replay = await provider.create(input, mode);
        assert.deepEqual(replay, created);
        assert.equal(
          await fs.readFile(path.join(created.path, "src/sample.txt"), "utf8"),
          mode + " private edit\n",
        );
        if (mode === "VIRTUAL") {
          const launched = await promisify(execFile)(
            process.execPath,
            [
              "-e",
              "process.stdout.write(require('node:fs').readFileSync('src/sample.txt','utf8'))",
            ],
            { cwd: created.path, timeout: 10000 },
          );
          assert.equal(launched.stdout, "VIRTUAL private edit\n");
        }
        const finished = await provider.finish(created.sliceId);
        assert.notEqual(finished.snapshotChain.at(-1), revision.revision_id);
        const completedMetrics = await provider.metrics(created.sliceId);
        assert.equal(completedMetrics.dirty.pending_checkpoint, false);
        assert.equal(completedMetrics.dirty.journal_paths, 0);
        const accepted = await sdk.revision(finished.snapshotChain.at(-1));
        const changed = await sdk.lookup(
          accepted.root_tree_id,
          "src/sample.txt",
        );
        assert.notEqual(changed.entry.object_id, file);
        if (mode === "VIRTUAL") {
          const ownerPath = path.join(
            root,
            "provider",
            "native-source",
            created.sliceId,
            "overlay",
            "owner.json",
          );
          const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
          process.kill(owner.pid, "SIGKILL");
          await new Promise((resolve) => setTimeout(resolve, 100));
          const restarted = await provider.create(input, mode);
          assert.equal(restarted.path, created.path);
          assert.equal(
            await fs.readFile(
              path.join(created.path, "src/sample.txt"),
              "utf8",
            ),
            "VIRTUAL private edit\n",
          );
        }
        receipts.push({
          mode,
          source_revision: revision.revision_id,
          checkpoint_revision: accepted.revision_id,
        });
      } catch (error) {
        primaryFailure = error;
        console.error("Native provider primary failure:", error);
        throw error;
      } finally {
        try {
          await provider.discard(created.sliceId);
        } catch (cleanup) {
          console.error("Native provider cleanup failure:", cleanup);
          if (!primaryFailure) throw cleanup;
        }
      }
      await client.close(await client.detail(descriptor.workspace_id));
    }
    return {
      status: "PASS",
      checks: [
        "signed native source configuration drives sparse and virtual environment providers without a project checkout",
        "repeated creation preserves dirty files and real checkpoints preserve source identity",
        "host-spawned process enters virtual working directory while independent source daemon serves FUSE",
        "discard unmounts owned views and fixture closes its durable workspaces",
      ],
      receipts,
    };
  } finally {
    if (previous === undefined)
      delete process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG;
    else process.env.HYPERFIDE_VIRTUAL_HOST_CONFIG = previous;
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (cleanup) {
      console.error(
        "Native provider retained diagnostic state:",
        root,
        cleanup,
      );
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = process.env.SOURCE_SIGNED_TRANSPORT_INPUT;
  const { config } = JSON.parse(await fs.readFile(input, "utf8"));
  const receipt = await runNativeVirtualProvider({
    config,
    directory: path.dirname(input),
  });
  await fs.mkdir("build/source-control/native-provider", { recursive: true });
  await fs.writeFile(
    "build/source-control/native-provider/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
}
