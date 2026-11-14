import assert from "node:assert/strict";
import { constants } from "node:fs";
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
const component = process.env.HYPERFIDE_VIRTUAL_COMPONENT === "1";
const file = process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE;
const options = file ? JSON.parse(await fs.readFile(file, "utf8")) : {};
const host =
  options.virtual_host ??
  (component
    ? {}
    : {
        mount: {
          path: "/usr/bin/mount",
          sha256: hash(await fs.readFile("/usr/bin/mount")),
        },
        unmount: {
          path: "/usr/bin/umount",
          sha256: hash(await fs.readFile("/usr/bin/umount")),
        },
      });
const capabilities = component ? null : await discoverVirtualHost(host);
const report = async (value) => {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.HYPERFIDE_VIRTUAL_RECEIPT)
    await fs.writeFile(process.env.HYPERFIDE_VIRTUAL_RECEIPT, text);
  console.log(text);
};
if ((!component && !capabilities.available) || !file) {
  await report({
    status: "UNRUN",
    capabilities,
    missing_environment: !file ? ["HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE"] : [],
    full_case_qualified: false,
  });
  process.exitCode = 2;
} else {
  const sdk = new SourceControlClient(options),
    calls = [],
    fetchedObjects = [];
  const qualifiedRevision = (
    await execute("git", ["rev-parse", "HEAD"])
  ).stdout.trim();
  async function requestFixture(type, input = {}) {
    assert.equal(
      typeof process.send,
      "function",
      "The owned native fixture is required",
    );
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.off("message", receive);
        reject(new Error("Virtual fixture request timed out"));
      }, 60000);
      function receive(message) {
        if (message.request_id !== request_id) return;
        clearTimeout(timer);
        process.off("message", receive);
        message.error ? reject(new Error(message.error)) : resolve(message);
      }
      process.on("message", receive);
      process.send({ type, request_id, ...input });
    });
  }
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
        const result = await sdk.call(action, input, {
          ...callOptions,
          ...(options.authority ? { authority: options.authority } : {}),
        });
        if (action === "source.objects.read")
          fetchedObjects.push({
            object_id: input.object_id,
            kind: result.kind,
            bytes: Buffer.from(result.payload_base64, "base64").length,
          });
        return result;
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
    max_file_bytes: 8 * 1024 * 1024,
    materialized_bytes: 8 * 1024 * 1024,
    dirty_bytes: 1024,
  };
  const objects = {};
  const chunkSize = 4 * 1024 * 1024;
  const largeBytes = Buffer.concat([
    Buffer.alloc(chunkSize, 0x31),
    Buffer.alloc(chunkSize, 0x72),
  ]);
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
    "src/large.bin": largeBytes,
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
  const pagedNames = Array.from(
    { length: 200 },
    (_, i) => String(i).padStart(3, "0") + "x".repeat(190),
  );
  for (const name of pagedNames)
    objects["src/paged/" + name] = {
      path: "src/paged/" + name,
      operation: "put",
      kind: "file",
      mode: "100644",
      object_id: objects["src/cold.txt"].object_id,
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
  async function checkVirtualComponent() {
    assert.equal(options.qualification_backend, "S3_HTTP_FIXTURE");
    const virtual = new NativeVirtualFilesystem(
      client,
      cache,
      journal,
      descriptor,
      mountOptions,
    );
    await virtual.current();
    await virtual.load();
    assert.equal(virtual.metrics.hydratedBytes, 0);
    assert.equal(
      descriptor.attempt_expires_at,
      (await client.detail(descriptor.workspace_id)).attempt_expires_at,
    );
    assert(Date.parse(descriptor.attempt_expires_at) > Date.now());
    const names = async (view, name) => {
      const result = [];
      for await (const entry of view.directory(await view.lookup(name)))
        if (entry.name !== "." && entry.name !== "..") result.push(entry.name);
      return result.sort();
    };
    assert.deepEqual(await names(virtual, ""), ["src"]);
    const beforePages = calls.filter(
      (call) => call.action === "source.trees.entries",
    ).length;
    assert.deepEqual(await names(virtual, "src/paged"), pagedNames);
    assert(
      calls.filter((call) => call.action === "source.trees.entries").length -
        beforePages >=
        2,
    );
    assert.equal(virtual.metrics.contentHydrations, 0);
    assert.equal(fetchedObjects.length, 0);
    assert.equal(
      (await virtual.bytes(await virtual.lookup("src/cold.txt"))).toString(),
      "candidate: cold immutable content\n",
    );
    await assert.rejects(
      virtual.lookup("outside/secret.txt"),
      (error) => error.code === "ENOENT",
    );
    passed(
      "component virtual path listing spans pages without hydration and reads only selected pinned source",
    );

    const signal = new AbortController().signal;
    const beforeOpen = fetchedObjects.length;
    const large = await virtual.lookup("src/large.bin");
    const opened = await virtual.open(large, constants.O_RDONLY, false, signal);
    const held = virtual.handle(opened.readBigUInt64LE(0));
    assert.equal(
      fetchedObjects
        .slice(beforeOpen)
        .filter((object) => object.kind === "chunk").length,
      0,
    );
    assert.deepEqual(
      await virtual.readRange(held, 1024, 8192, signal),
      largeBytes.subarray(1024, 9216),
    );
    const firstChunks = fetchedObjects
      .slice(beforeOpen)
      .filter((object) => object.kind === "chunk");
    assert.equal(firstChunks.length, 1);
    assert.equal(firstChunks[0].bytes, chunkSize);
    assert(
      fetchedObjects
        .slice(beforeOpen)
        .reduce((sum, object) => sum + object.bytes, 0) <=
        chunkSize + 4096,
    );
    assert.deepEqual(
      await virtual.readRange(held, chunkSize - 32, 64, signal),
      largeBytes.subarray(chunkSize - 32, chunkSize + 32),
    );
    const chunks = fetchedObjects
      .slice(beforeOpen)
      .filter((object) => object.kind === "chunk");
    assert.equal(new Set(chunks.map((object) => object.object_id)).size, 2);
    assert.equal(
      chunks.reduce((sum, object) => sum + object.bytes, 0),
      2 * chunkSize,
    );
    assert.equal(virtual.metrics.rangeFetchedBytes, 2 * chunkSize);
    assert.equal(
      (await virtual.readRange(held, largeBytes.length, 64, signal)).length,
      0,
    );
    await virtual.remove(large);
    await assert.rejects(
      virtual.lookup("src/large.bin"),
      (error) => error.code === "ENOENT",
    );
    assert.deepEqual(
      await virtual.readRange(held, chunkSize + 128, 64, signal),
      largeBytes.subarray(chunkSize + 128, chunkSize + 192),
    );
    assert.equal(virtual.metrics.rangeFetchedBytes, 2 * chunkSize);
    passed(
      "component chunk ranges fetch only covering chunks within bounded bytes and held base bytes survive unlink",
    );

    const expiryReceipts = [];
    for (const kind of ["attempt", "capability"]) {
      let transport = sdk;
      const expiryClient = new NativeWorkspaceClient(
        {
          call: (action, input, callOptions) =>
            transport.call(action, input, callOptions),
        },
        options.scope,
      );
      const attempt_expires_at = new Date(
        Date.now() + (kind === "attempt" ? 10000 : 120000),
      ).toISOString();
      const admission = await expiryClient.open({
        base_revision_id: created.revision_id,
        mode: "VIRTUAL",
        read_paths: ["src"],
        write_paths: ["src"],
        budgets,
        attempt_expires_at,
      });
      assert.equal(admission.attempt_expires_at, attempt_expires_at);
      const acknowledged = await expiryClient.checkpoint({
        scope: options.scope,
        workspace_id: admission.workspace_id,
        expected_workspace_generation: admission.workspace_generation,
        expected_scope_generation: admission.scope_generation,
        base_revision_id: admission.base_revision_id,
        overlay_generation: "1",
        operation_id: randomUUID(),
        changes: [objects["src/cold.txt"]],
      });
      assert.equal(
        acknowledged.workspace.attempt_expires_at,
        attempt_expires_at,
      );
      const expiryOptions = {
        ...mountOptions,
        stateDirectory: path.join(directory, kind + "-overlay"),
      };
      let expiryJournal = new SourceWorkspaceJournal(
        path.join(directory, kind + "-journal"),
      );
      let expiryView = new NativeVirtualFilesystem(
        expiryClient,
        cache,
        expiryJournal,
        acknowledged.workspace,
        expiryOptions,
      );
      await expiryView.load();
      const retained = Buffer.from("retained dirty bytes\n");
      await expiryView.store(await expiryView.lookup("src/cold.txt"), retained);
      const statePath = path.join(expiryOptions.stateDirectory, "virtual.json");
      const beforeState = await fs.readFile(statePath);
      const state = JSON.parse(beforeState);
      assert.equal(state.descriptor.attempt_expires_at, attempt_expires_at);
      const altered = new NativeVirtualFilesystem(
        expiryClient,
        cache,
        expiryJournal,
        {
          ...acknowledged.workspace,
          attempt_expires_at: new Date(
            Date.parse(attempt_expires_at) + 1000,
          ).toISOString(),
        },
        expiryOptions,
      );
      await assert.rejects(
        altered.load(),
        (error) => error.code === "WORKSPACE_STALE",
      );
      await assert.rejects(
        altered.current("src/cold.txt", true),
        (error) => error.code === "WORKSPACE_STALE",
      );
      expiryJournal = new SourceWorkspaceJournal(
        path.join(directory, kind + "-journal"),
      );
      expiryView = new NativeVirtualFilesystem(
        expiryClient,
        cache,
        expiryJournal,
        await client.detail(admission.workspace_id),
        expiryOptions,
      );
      await expiryView.load();
      const node = await expiryView.lookup("src/cold.txt");
      assert.deepEqual(await expiryView.bytes(node), retained);
      assert.deepEqual(await fs.readFile(statePath), beforeState);
      const record = state.overlay.find(
        (entry) => entry.path === "src/cold.txt",
      );
      assert.equal(record.dirty, true);
      const retainedPath = path.join(
        expiryOptions.stateDirectory,
        "data",
        record.id,
      );
      assert.deepEqual(await fs.readFile(retainedPath), retained);
      const beforeJournal = await expiryJournal.snapshot();
      let expires_at = attempt_expires_at;
      if (kind === "capability") {
        const { grant } = await requestFixture("virtual-expiring-grant");
        expires_at = grant.expires_at;
        assert(Date.parse(expires_at) < Date.parse(attempt_expires_at));
        transport = new SourceControlClient({ ...options, token: grant.token });
      }
      await expiryView.current("src/cold.txt", true);
      const remaining = Date.parse(expires_at) - Date.now();
      assert(
        remaining > 0,
        "The real deadline must expire while the virtual view is retained",
      );
      await new Promise((resolve) => setTimeout(resolve, remaining + 50));
      const refusal = (error) =>
        error.code ===
        (kind === "attempt" ? "ATTEMPT_EXPIRED" : "SCOPE_DENIED");
      await assert.rejects(expiryView.current("src/cold.txt", true), refusal);
      await assert.rejects(
        expiryView.store(node, Buffer.from("lost")),
        refusal,
      );
      await assert.rejects(
        expiryView.open(node, constants.O_RDWR, false, signal),
        refusal,
      );
      await assert.rejects(expiryView.checkpoint(), refusal);
      const rejectedOperation = randomUUID();
      await assert.rejects(
        expiryClient.checkpoint({
          scope: options.scope,
          workspace_id: admission.workspace_id,
          expected_workspace_generation:
            acknowledged.workspace.workspace_generation,
          expected_scope_generation: acknowledged.workspace.scope_generation,
          base_revision_id: acknowledged.revision_id,
          overlay_generation: "2",
          operation_id: rejectedOperation,
          changes: [],
        }),
        refusal,
      );
      assert.deepEqual(
        await client.detail(admission.workspace_id),
        acknowledged.workspace,
      );
      assert.deepEqual(await fs.readFile(statePath), beforeState);
      assert.deepEqual(await fs.readFile(retainedPath), retained);
      assert.deepEqual(await expiryJournal.snapshot(), beforeJournal);
      assert.equal((await client.operation(rejectedOperation)).state, "ABSENT");
      if (kind === "attempt")
        assert.deepEqual(await expiryView.bytes(node), retained);
      else await assert.rejects(expiryView.bytes(node), refusal);
      expiryReceipts.push({
        kind,
        expires_at,
        workspace_id: admission.workspace_id,
        checkpoint_revision_id: acknowledged.revision_id,
      });
      passed(
        "component real " +
          kind +
          " expiry refuses virtual writes and both checkpoint paths after restart, retaining dirty bytes and the acknowledged revision",
      );
    }
    await report({
      revision: qualifiedRevision,
      status: "COMPONENT_PASS",
      full_case_qualified: false,
      storage_backend: options.qualification_backend,
      mounted: false,
      scope: options.scope,
      workspace_id: descriptor.workspace_id,
      checks,
      expiry: expiryReceipts,
      metrics: virtual.metrics,
      source_object_read_calls: calls.filter(
        (call) => call.action === "source.objects.read",
      ).length,
      live: {
        status: "UNRUN",
        command:
          "cd tools/hyperfide && corepack enable && python3 tests/hyperfide/cases/source_control/3_2.py",
        requirements: [
          "/dev/fuse",
          "pinned mount helpers",
          "object store credentials",
        ],
      },
    });
  }
  if (component) {
    try {
      await checkVirtualComponent();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } else {
    const unavailableOptions = {
      ...mountOptions,
      mountpoint: path.join(directory, "unavailable-view"),
      stateDirectory: path.join(directory, "unavailable-overlay"),
      host: {
        ...host,
        mount: { ...host.mount, sha256: "sha256:" + "0".repeat(64) },
      },
    };
    const unavailableHost = await discoverVirtualHost(unavailableOptions.host);
    assert.equal(unavailableHost.available, false);
    assert.deepEqual(unavailableHost.fallback.modes, [
      "SPARSE",
      "MATERIALIZED",
    ]);
    assert.equal(unavailableHost.fallback.requiresExplicitSelection, true);
    const readsBeforeRefusal = calls.filter(
      (call) => call.action === "source.objects.read",
    ).length;
    const unavailableView = new NativeVirtualFilesystem(
      client,
      cache,
      journal,
      descriptor,
      unavailableOptions,
    );
    await assert.rejects(
      unavailableView.mount(),
      (error) => error.code === "VIRTUAL_FILESYSTEM_UNAVAILABLE",
    );
    assert.equal(
      calls.filter((call) => call.action === "source.objects.read").length,
      readsBeforeRefusal,
    );
    assert(
      !(await fs.readFile("/proc/self/mountinfo", "utf8")).includes(
        unavailableOptions.mountpoint,
      ),
    );
    passed(
      "unavailable host executable capability refuses mounting without hydration and requires explicit sparse fallback",
    );
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
      async function checkChunkedRangeRead() {
        const beforeOpen = fetchedObjects.length;
        const held = await fs.open(path.join(mountpoint, "src/large.bin"), "r");
        try {
          assert.equal(
            fetchedObjects
              .slice(beforeOpen)
              .filter((object) => object.kind === "chunk").length,
            0,
          );
          const beforeRead = fetchedObjects.length;
          const buffer = Buffer.alloc(8192);
          assert.equal(
            (await held.read(buffer, 0, buffer.length, 1024)).bytesRead,
            buffer.length,
          );
          assert.deepEqual(
            buffer,
            largeBytes.subarray(1024, 1024 + buffer.length),
          );
          const downloaded = fetchedObjects
            .slice(beforeRead)
            .filter((object) => object.kind === "chunk");
          assert.equal(downloaded.length, 1);
          assert.equal(downloaded[0].bytes, chunkSize);
          assert(
            fetchedObjects
              .slice(beforeOpen)
              .reduce((sum, object) => sum + object.bytes, 0) <=
              chunkSize + 4096,
          );
          const crossing = Buffer.alloc(64);
          assert.equal(
            (await held.read(crossing, 0, crossing.length, chunkSize - 32))
              .bytesRead,
            crossing.length,
          );
          assert.deepEqual(
            crossing,
            largeBytes.subarray(chunkSize - 32, chunkSize + 32),
          );
          const allChunks = fetchedObjects
            .slice(beforeRead)
            .filter((object) => object.kind === "chunk");
          assert.equal(
            new Set(allChunks.map((object) => object.object_id)).size,
            2,
          );
          assert(
            allChunks.reduce((sum, object) => sum + object.bytes, 0) <=
              2 * chunkSize,
          );
          assert(virtual.metrics.rangeReads >= 2);
          assert.equal(virtual.metrics.rangeFetchedBytes, 2 * chunkSize);
          await fs.writeFile(
            path.join(mountpoint, "src/.large-replacement"),
            "replacement",
          );
          await fs.rename(
            path.join(mountpoint, "src/.large-replacement"),
            path.join(mountpoint, "src/large.bin"),
          );
          const stable = Buffer.alloc(64);
          assert.equal(
            (await held.read(stable, 0, stable.length, chunkSize + 128))
              .bytesRead,
            stable.length,
          );
          assert.deepEqual(
            stable,
            largeBytes.subarray(chunkSize + 128, chunkSize + 192),
          );
          assert.equal(
            await fs.readFile(path.join(mountpoint, "src/large.bin"), "utf8"),
            "replacement",
          );
        } finally {
          await held.close();
        }
        passed(
          "chunked range reads fetch only covering chunks within bounded bytes and retain immutable base bytes across replacement",
        );
      }
      await checkChunkedRangeRead();
      const hydrationBeforeListing = virtual.metrics.contentHydrations;
      assert.deepEqual(
        (await fs.readdir(path.join(mountpoint, "src/paged"))).sort(),
        pagedNames,
      );
      assert.equal(virtual.metrics.contentHydrations, hydrationBeforeListing);
      await fs.writeFile(path.join(mountpoint, "src/transient"), "transient");
      await fs.rename(
        path.join(mountpoint, "src/transient"),
        path.join(mountpoint, "src/renamed"),
      );
      assert.equal(
        await fs.readFile(path.join(mountpoint, "src/renamed"), "utf8"),
        "transient",
      );
      await assert.rejects(
        fs.stat(path.join(mountpoint, "src/transient")),
        (error) => error.code === "ENOENT",
      );
      await fs.unlink(path.join(mountpoint, "src/renamed"));
      await assert.rejects(
        fs.stat(path.join(mountpoint, "src/renamed")),
        (error) => error.code === "ENOENT",
      );
      passed(
        "multi-page directory enumeration avoids hydration and ordinary rename and deletion remain coherent",
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
        fs.writeFile(
          path.join(mountpoint, "src/too-large"),
          Buffer.alloc(2048),
        ),
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
      async function checkAttemptAndCapabilityExpiry() {
        const expiryReceipts = [];
        for (const kind of ["attempt", "capability"]) {
          let transport = sdk;
          const expiryClient = new NativeWorkspaceClient(
            {
              call: (action, input, callOptions) =>
                transport.call(action, input, callOptions),
            },
            options.scope,
          );
          const attempt_expires_at = new Date(
            Date.now() + (kind === "attempt" ? 10000 : 120000),
          ).toISOString();
          const opened = await expiryClient.open({
            base_revision_id: created.revision_id,
            mode: "VIRTUAL",
            read_paths: ["src"],
            write_paths: ["src"],
            budgets,
            attempt_expires_at,
          });
          assert.equal(opened.attempt_expires_at, attempt_expires_at);
          const expiryOptions = {
            ...mountOptions,
            mountpoint: path.join(directory, kind + "-view"),
            stateDirectory: path.join(directory, kind + "-overlay"),
          };
          const expiryJournal = new SourceWorkspaceJournal(
            path.join(directory, kind + "-journal"),
          );
          const expiryView = new NativeVirtualFilesystem(
            expiryClient,
            cache,
            expiryJournal,
            opened,
            expiryOptions,
          );
          await expiryView.mount();
          try {
            const filename = path.join(
              expiryOptions.mountpoint,
              "src/expiry.txt",
            );
            await fs.writeFile(filename, "acknowledged\n");
            const acknowledged = await expiryView.checkpoint();
            let expires_at = attempt_expires_at;
            if (kind === "capability") {
              const { grant } = await requestFixture("virtual-expiring-grant");
              expires_at = grant.expires_at;
              assert(Date.parse(expires_at) < Date.parse(attempt_expires_at));
              transport = new SourceControlClient({
                ...options,
                token: grant.token,
              });
            }
            const retained = Buffer.from("retained dirty bytes\n");
            await fs.writeFile(filename, retained);
            const writable = await fs.open(filename, "r+");
            try {
              const statePath = path.join(
                expiryOptions.stateDirectory,
                "virtual.json",
              );
              const beforeState = await fs.readFile(statePath);
              const beforeJournal = await expiryJournal.snapshot();
              const state = JSON.parse(beforeState);
              const record = state.overlay.find(
                (entry) => entry.path === "src/expiry.txt",
              );
              assert.equal(record.dirty, true);
              const retainedPath = path.join(
                expiryOptions.stateDirectory,
                "data",
                record.id,
              );
              assert.deepEqual(await fs.readFile(retainedPath), retained);
              const remaining = Date.parse(expires_at) - Date.now();
              assert(
                remaining > 0,
                "The real deadline must expire while the file is held open",
              );
              await new Promise((resolve) =>
                setTimeout(resolve, remaining + 50),
              );
              await assert.rejects(
                writable.write(Buffer.from("lost"), 0, 4, 0),
                (error) => error.code === "EACCES",
              );
              await assert.rejects(
                fs.writeFile(filename, "lost"),
                (error) => error.code === "EACCES",
              );
              await assert.rejects(
                fs.writeFile(
                  path.join(expiryOptions.mountpoint, "src/after-expiry"),
                  "lost",
                ),
                (error) => error.code === "EACCES",
              );
              const refusal = (error) =>
                kind === "attempt"
                  ? error.code === "ATTEMPT_EXPIRED"
                  : error.code === "SCOPE_DENIED";
              await assert.rejects(expiryView.checkpoint(), refusal);
              const operation_id = randomUUID();
              await assert.rejects(
                transport.call(
                  "source.workspaces.checkpoint",
                  {
                    workspace_id: opened.workspace_id,
                    expected_workspace_generation:
                      acknowledged.workspace.workspace_generation,
                    expected_scope_generation:
                      acknowledged.workspace.scope_generation,
                    base_revision_id: acknowledged.revision_id,
                    overlay_generation: "99",
                    operation_id,
                    changes: [],
                  },
                  { operation_id, idempotency_key: operation_id },
                ),
                refusal,
              );
              const current = await client.detail(opened.workspace_id);
              assert.equal(
                current.checkpoint_revision_id,
                acknowledged.revision_id,
              );
              assert.equal(current.base_revision_id, acknowledged.revision_id);
              assert.equal(
                current.workspace_generation,
                acknowledged.workspace.workspace_generation,
              );
              assert.equal(current.attempt_expires_at, attempt_expires_at);
              assert.deepEqual(await fs.readFile(statePath), beforeState);
              assert.deepEqual(await fs.readFile(retainedPath), retained);
              assert.deepEqual(await expiryJournal.snapshot(), beforeJournal);
              if (kind === "attempt")
                assert.deepEqual(await fs.readFile(filename), retained);
              else
                await assert.rejects(
                  fs.readFile(filename),
                  (error) => error.code === "EACCES",
                );
              expiryReceipts.push({
                kind,
                expires_at,
                workspace_id: opened.workspace_id,
                checkpoint_revision_id: acknowledged.revision_id,
              });
            } finally {
              await writable.close();
            }
          } finally {
            await expiryView.close();
          }
          passed(
            "real " +
              kind +
              " expiry while mounted refuses existing and new writes and both checkpoint paths, retaining dirty bytes and the acknowledged revision",
          );
        }
        return expiryReceipts;
      }
      const expiryReceipts = await checkAttemptAndCapabilityExpiry();
      await report({
        revision: qualifiedRevision,
        status:
          options.qualification_backend === "S3_HTTP_FIXTURE"
            ? "COMPONENT_PASS"
            : "PASS",
        full_case_qualified:
          options.qualification_backend !== "S3_HTTP_FIXTURE",
        storage_backend:
          options.qualification_backend ?? "CONFIGURED_NATIVE_SERVICE",
        profile: capabilities.profile.id,
        mount_helpers: host,
        scope: options.scope,
        workspace_id: descriptor.workspace_id,
        kernel: capabilities.kernel,
        checks,
        expiry: expiryReceipts,
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
}
