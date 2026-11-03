import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { NativeWorkspaceClient } from "../../../core/host-daemon/src/source-control/client.ts";
import { NativeObjectCache } from "../../../core/host-daemon/src/source-control/cache.ts";
import { SourceWorkspaceJournal } from "../../../core/host-daemon/src/source-control/journal.ts";
import { NativeVirtualFilesystem } from "../../../core/host-daemon/src/source-control/virtual-filesystem.ts";
import { discoverVirtualHost } from "../../../core/host-daemon/src/source-control/capabilities.ts";
import { SourceControlClient } from "../../../sdk/source-control/src/client.ts";

const execute = promisify(execFile),
  hash = (bytes) =>
    "sha256:" + createHash("sha256").update(bytes).digest("hex");
const file = process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE;
const options = file ? JSON.parse(await fs.readFile(file, "utf8")) : {};
const host = options.virtual_host ?? {
  mount: {
    path: "/usr/bin/mount",
    sha256: hash(await fs.readFile("/usr/bin/mount")),
  },
  unmount: {
    path: "/usr/bin/umount",
    sha256: hash(await fs.readFile("/usr/bin/umount")),
  },
};
const capabilities = await discoverVirtualHost(host);
const report = async (value) => {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.HYPERFIDE_VIRTUAL_RECEIPT)
    await fs.writeFile(process.env.HYPERFIDE_VIRTUAL_RECEIPT, text);
  console.log(text);
};
if (!capabilities.available || !file) {
  await report({
    status: "UNRUN",
    capabilities,
    missing_environment: !file ? ["HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE"] : [],
    full_case_qualified: false,
  });
  process.exitCode = 2;
} else {
  const sdk = new SourceControlClient(options),
    calls = [];
  let fault = null;
  const client = new NativeWorkspaceClient(
    {
      call: async (action, input, callOptions) => {
        calls.push({ action, input });
        if (fault === "read" && action === "source.objects.read")
          throw Object.assign(
            new Error("Injected network loss at real object transport"),
            { code: "NETWORK_UNAVAILABLE" },
          );
        if (fault === "authority" && action === "source.workspaces.detail")
          return new SourceControlClient({
            ...options,
            token: options.denied_token,
          }).call(action, input, callOptions);
        if (fault === "delay" && action === "source.objects.read")
          await new Promise((resolve) => setTimeout(resolve, 1000));
        return sdk.call(action, input, {
          ...callOptions,
          ...(options.authority ? { authority: options.authority } : {}),
        });
      },
    },
    options.scope,
  );
  const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hyperfide-virtual-"),
    ),
    mountpoint = path.join(directory, "view"),
    checks = [];
  const passed = (message) => {
    checks.push(message);
    console.error("virtual-source: " + message);
  };
  const budgets = {
    cache_bytes: 8 * 1024 * 1024,
    max_cache_entries: 1024,
    max_file_bytes: 1024 * 1024,
    materialized_bytes: 8 * 1024 * 1024,
    dirty_bytes: 1024,
  };
  const objects = {};
  for (const [name, bytes] of Object.entries({
    "src/main.c": Buffer.from(
      '#include <stdio.h>\nint main(void){puts("virtual source");return 0;}\n',
    ),
    "src/run.sh": Buffer.from('#!/bin/sh\nprintf "virtual executable\\n"\n'),
    "src/cold.txt": Buffer.from("candidate: cold immutable content\n"),
    "src/failure.txt": Buffer.from(
      "must not become an empty successful read\n",
    ),
    "src/cancel.txt": Buffer.from("cancelled reader retains valid source\n"),
    "outside/secret.txt": Buffer.from("unselected source\n"),
  }))
    objects[name] = {
      path: name,
      operation: "put",
      kind: "file",
      mode: name.endsWith(".sh") ? "100755" : "100644",
      object_id: await client.putFile(bytes),
    };
  objects["src/link"] = {
    path: "src/link",
    operation: "put",
    kind: "symlink",
    mode: "120000",
    object_id: await client.putObject("blob", Buffer.from("run.sh")),
  };
  const empty = await sdk.call("source.objects.put", {
    kind: "tree-leaf",
    payload_base64: Buffer.from('[1,"",[]]').toString("base64"),
  });
  const tree = await sdk.call("source.trees.patch", {
    tree_id: empty.object_id,
    patches: Object.values(objects),
  });
  const operation = randomUUID(),
    created = await sdk.call(
      "source.revisions.create",
      {
        change_id: randomUUID(),
        root_tree_id: tree.root_tree_id,
        parent_revision_ids: [],
        predecessor_revision_ids: [],
        provenance: {
          author: {
            name: "Virtual filesystem qualification",
            email: "virtual@example.invalid",
          },
          message: "Native virtual filesystem source",
          timestamp: new Date().toISOString(),
        },
      },
      { operation_id: operation, idempotency_key: operation },
    );
  const descriptor = await client.open({
    base_revision_id: created.revision_id,
    mode: "VIRTUAL",
    read_paths: ["src"],
    write_paths: ["src"],
    budgets,
  });
  const cache = new NativeObjectCache(path.join(directory, "cache"), {
      max_bytes: budgets.cache_bytes,
      max_entries: budgets.max_cache_entries,
      max_object_bytes: 5 * 1024 * 1024,
    }),
    journal = new SourceWorkspaceJournal(path.join(directory, "journal"));
  const mountOptions = {
    mountpoint,
    stateDirectory: path.join(directory, "overlay"),
    host,
    uid: process.getuid(),
    gid: process.getgid(),
    maxNodes: 1024,
    maxOpenHandles: 32,
    maxInflight: 16,
  };
  let virtual = new NativeVirtualFilesystem(
      client,
      cache,
      journal,
      descriptor,
      mountOptions,
    ),
    mounted = false;
  let firstMountMetrics;
  try {
    const before = calls.filter(
      (call) => call.action === "source.objects.read",
    ).length;
    const ready = await virtual.mount();
    mounted = true;
    assert.equal(ready.state, "READY");
    assert.equal(ready.hydratedBytes, 0);
    assert.equal(
      calls.filter((call) => call.action === "source.objects.read").length,
      before,
    );
    assert.deepEqual(await fs.readdir(mountpoint), ["src"]);
    assert.equal(virtual.metrics.contentHydrations, 0);
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/cold.txt"), "utf8"),
      "candidate: cold immutable content\n",
    );
    assert(virtual.metrics.hydratedBytes > 0);
    await assert.rejects(
      fs.readFile(path.join(mountpoint, "outside/secret.txt")),
      (error) => error.code === "ENOENT",
    );
    passed(
      "real Linux FUSE mount becomes ready without content hydration and reads only the pinned selected source",
    );
    const compile = options.compiler ?? "/usr/bin/cc";
    await execute(compile, [
      path.join(mountpoint, "src/main.c"),
      "-o",
      path.join(directory, "compiled"),
    ]);
    assert.equal(
      (await execute(path.join(directory, "compiled"))).stdout,
      "virtual source\n",
    );
    assert.equal(
      (
        await execute("/bin/sh", [
          "-c",
          'exec "$1"',
          "sh",
          path.join(mountpoint, "src/run.sh"),
        ])
      ).stdout,
      "virtual executable\n",
    );
    assert.equal(
      await fs.readlink(path.join(mountpoint, "src/link")),
      "run.sh",
    );
    passed(
      "compiler, executable mode and symlink reads run through the actual mounted filesystem",
    );
    const mmapSource = path.join(directory, "mmap.c"),
      mmapBinary = path.join(directory, "mmap");
    await fs.writeFile(
      mmapSource,
      "#include <sys/mman.h>\n#include <fcntl.h>\n#include <unistd.h>\n#include <errno.h>\nint main(int n,char **v){(void)n;int f=open(v[1],O_RDONLY);if(f<0)return 2;void *p=mmap(0,1,PROT_READ,MAP_SHARED,f,0);if(p==MAP_FAILED&&(errno==ENODEV||errno==EOPNOTSUPP)){close(f);return 0;}return 3;}\n",
    );
    await execute(compile, [mmapSource, "-o", mmapBinary]);
    await execute(mmapBinary, [path.join(mountpoint, "src/cold.txt")]);
    const childLock =
      "import fcntl,sys; f=open(sys.argv[1]);\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(3)";
    const lockProgram =
      'import fcntl,subprocess,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); child=subprocess.run([sys.executable,"-c",' +
      JSON.stringify(childLock) +
      ",sys.argv[1]]); sys.exit(child.returncode)";
    await execute(options.python ?? "/usr/bin/python3", [
      "-c",
      lockProgram,
      path.join(mountpoint, "src/cold.txt"),
    ]);
    passed(
      "unsupported mmap returns an explicit kernel error and local advisory file locks exclude another process",
    );

    const held = await fs.open(path.join(mountpoint, "src/cold.txt"), "r");
    const newer = await client.putFile(
      Buffer.from("candidate: newer upstream bytes\n"),
    );
    const changed = await sdk.call("source.trees.patch", {
      tree_id: tree.root_tree_id,
      patches: [{ ...objects["src/cold.txt"], object_id: newer }],
    });
    assert.equal(
      typeof process.send,
      "function",
      "Acceptance qualification requires the owned native service fixture",
    );
    const request_id = randomUUID();
    const accepted = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.off("message", receive);
        reject(new Error("Acceptance controller timeout"));
      }, 60000);
      const receive = (message) => {
        if (message.request_id !== request_id) return;
        clearTimeout(timer);
        process.off("message", receive);
        message.error
          ? reject(new Error(message.error))
          : resolve(message.accepted);
      };
      process.on("message", receive);
      process.send({
        type: "virtual-accept",
        request_id,
        root_tree_id: changed.root_tree_id,
        parent_revision_id: created.revision_id,
      });
    });
    assert.match(accepted.acceptance_id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(accepted.root_tree_id, changed.root_tree_id);
    assert.equal(
      await held.readFile("utf8"),
      "candidate: cold immutable content\n",
    );
    await held.close();
    passed(
      "open file handles keep pinned source bytes while independently qualified upstream acceptance advances",
    );
    await fs.writeFile(
      path.join(mountpoint, "src/.save"),
      "durable private edit\n",
    );
    await fs.rename(
      path.join(mountpoint, "src/.save"),
      path.join(mountpoint, "src/cold.txt"),
    );
    await fs.truncate(path.join(mountpoint, "src/cold.txt"), 7);
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/cold.txt"), "utf8"),
      "durable",
    );
    await assert.rejects(
      fs.writeFile(path.join(mountpoint, "src/too-large"), Buffer.alloc(2048)),
      (error) => ["ENOSPC", "EFBIG"].includes(error.code),
    );
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/cold.txt"), "utf8"),
      "durable",
    );
    passed(
      "atomic save and truncate persist private edits while dirty budget refusal preserves prior bytes",
    );
    fault = "read";
    await assert.rejects(
      fs.readFile(path.join(mountpoint, "src/failure.txt")),
      (error) => error.code === "EIO",
    );
    fault = null;
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/failure.txt"), "utf8"),
      "must not become an empty successful read\n",
    );
    fault = "authority";
    await assert.rejects(
      fs.readFile(path.join(mountpoint, "src/cold.txt")),
      (error) => ["EACCES", "EPERM"].includes(error.code),
    );
    fault = null;
    passed(
      "network and authority refusals surface as I/O errors and never replace source or dirty bytes with empty content",
    );
    fault = "delay";
    const cancelled = spawn(
      "/bin/cat",
      [path.join(mountpoint, "src/cancel.txt")],
      { stdio: "ignore" },
    );
    const cancelledExit = new Promise((resolve) =>
      cancelled.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    cancelled.kill("SIGTERM");
    const cancellation = await cancelledExit;
    assert.equal(cancellation.signal, "SIGTERM");
    fault = null;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/cancel.txt"), "utf8"),
      "cancelled reader retains valid source\n",
    );
    passed(
      "cancelled kernel hydration preserves the immutable cache and the next reader receives exact source bytes",
    );

    await fs.writeFile(path.join(mountpoint, "src/Case.txt"), "upper");
    await fs.writeFile(path.join(mountpoint, "src/case.txt"), "lower");
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/Case.txt"), "utf8"),
      "upper",
    );
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/case.txt"), "utf8"),
      "lower",
    );
    passed(
      "case-sensitive names remain separate on the declared Linux filesystem profile",
    );
    firstMountMetrics = { ...virtual.metrics };
    await virtual.close();
    mounted = false;
    virtual = new NativeVirtualFilesystem(
      client,
      cache,
      new SourceWorkspaceJournal(path.join(directory, "journal")),
      descriptor,
      mountOptions,
    );
    await virtual.mount();
    mounted = true;
    assert.equal(
      await fs.readFile(path.join(mountpoint, "src/cold.txt"), "utf8"),
      "durable",
    );
    const checkpoint = await virtual.checkpoint();
    assert.notEqual(checkpoint.revision_id, created.revision_id);
    const revision = await sdk.revision(checkpoint.revision_id);
    const preserved = await sdk.lookup(
      revision.root_tree_id,
      "outside/secret.txt",
    );
    assert.equal(
      preserved.entry.object_id,
      objects["outside/secret.txt"].object_id,
    );
    passed(
      "daemon restart reconciles the exact workspace journal, checkpoints dirty source and preserves unselected paths",
    );
    const finalMetrics = { ...virtual.metrics };
    await virtual.close();
    mounted = false;
    const stateFile = path.join(mountOptions.stateDirectory, "virtual.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    const dirty = state.overlay.find(
      (record) => record.path === "src/cold.txt",
    );
    const dataFile = path.join(mountOptions.stateDirectory, "data", dirty.id);
    const retainedBytes = await fs.readFile(dataFile);
    await fs.writeFile(dataFile, Buffer.alloc(retainedBytes.length, 0xff));
    const damaged = new NativeVirtualFilesystem(
      client,
      cache,
      new SourceWorkspaceJournal(path.join(directory, "journal")),
      checkpoint.workspace,
      mountOptions,
    );
    await assert.rejects(
      damaged.mount(),
      (error) => error.code === "VIRTUAL_STATE_CORRUPT",
    );
    await fs.writeFile(dataFile, retainedBytes);
    passed(
      "corrupt retained overlay bytes are rejected before mount readiness without changing the acknowledged source revision",
    );
    await report({
      status:
        options.qualification_backend === "S3_HTTP_FIXTURE"
          ? "COMPONENT_PASS"
          : "PASS",
      full_case_qualified: options.qualification_backend !== "S3_HTTP_FIXTURE",
      storage_backend:
        options.qualification_backend ?? "CONFIGURED_NATIVE_SERVICE",
      profile: capabilities.profile.id,
      scope: options.scope,
      workspace_id: descriptor.workspace_id,
      kernel: capabilities.kernel,
      checks,
      metrics: {
        first_mount: firstMountMetrics,
        restarted_mount: finalMetrics,
        total_hydrated_bytes:
          firstMountMetrics.hydratedBytes + finalMetrics.hydratedBytes,
      },
      source_object_read_calls: calls.filter(
        (call) => call.action === "source.objects.read",
      ).length,
      source_revision: created.revision_id,
      checkpoint_revision: checkpoint.revision_id,
      transport_faults:
        "explicitly injected after real source transport; normal reads and checkpoint use the configured source service",
    });
  } finally {
    if (mounted) await virtual.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
