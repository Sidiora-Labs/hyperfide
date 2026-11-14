import { createSourceS3Fixture } from "./backend.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHook } from "node:async_hooks";
import { watch } from "node:fs";
import path from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "../../../../../../core/control-plane/node_modules/pg/lib/index.js";
const spawnedProcesses = [];
const processObserver = createHook({
  init(id, type) {
    if (type === "PROCESSWRAP") spawnedProcesses.push(id);
  },
}).enable();
const folder = process.argv[2],
  load = (name) => import(pathToFileURL(folder + "/" + name + ".js"));
const [
  {
    SourceObjectService,
    sourceObjectId,
    encodeTreeNode,
    decodeTreeNode,
    encodeFileDescriptor,
    decodeFileDescriptor,
    FILE_CHUNK_BYTES,
  },
  { PostgresSourceObjectCatalog, protectSourceRoot },
  { PersistentTree },
  { S3SourceObjectBackend, sourceS3Configuration },
] = await Promise.all([
  load("objects"),
  load("object_catalog"),
  load("trees"),
  load("s3"),
]);
const [
  { createSourceApi },
  { SourceMetadata },
  { authorizeSource },
  {
    canonicalEnvelope,
    canonicalBytes,
    encodeSourceRequest,
    decodeSourceRequest,
    encodeSourceResponse,
    decodeSourceResponse,
  },
  { reserveSourceChild, reconcileSourceReservation },
  { SourceCollector },
] = await Promise.all([
  load("api"),
  load("metadata"),
  load("capabilities"),
  load("contracts"),
  load("pins"),
  load("gc"),
]);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});
const db = {
  transaction: async (body) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await body(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  },
};
const scope = {
    organisation_id: randomUUID(),
    repository_id: randomUUID(),
    security_domain_id: randomUUID(),
  },
  checks = [];
const fixture = await createSourceS3Fixture(),
  { requests } = fixture;
const catalog = new PostgresSourceObjectCatalog(db),
  s3 = new S3SourceObjectBackend(fixture.config),
  store = new SourceObjectService(catalog, s3),
  trees = new PersistentTree(store);
const packEvents = [],
  packWatchers = [];
async function packSnapshot() {
  const roots = [
    process.cwd(),
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/1.1",
    path.resolve("../..") + "/.git/objects/pack",
  ];
  const files = new Map();
  async function visit(root) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    for (const entry of entries) {
      const name = path.join(root, entry.name);
      if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name))
        await visit(name);
      else if (entry.isFile() && entry.name.endsWith(".pack"))
        files.set(
          path.resolve(name),
          createHash("sha256")
            .update(await fs.readFile(name))
            .digest("hex"),
        );
    }
  }
  for (const root of roots) await visit(root);
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}
const packsBefore = await packSnapshot();
for (const root of [
  process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/1.1",
  path.resolve("../..") + "/.git/objects/pack",
]) {
  try {
    packWatchers.push(
      watch(root, { recursive: true }, (_event, name) => {
        if (name?.endsWith(".pack")) packEvents.push(name);
      }),
    );
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
}
try {
  await pool.query("CREATE SCHEMA hyperfide");
  for (const migration of [
    "0736-source-control-storage.sql",
    "0738-source-control-capabilities.sql",
    "0746-source-control-retention.sql",
  ])
    await pool.query(
      await fs.readFile("core/control-plane/migrations/" + migration, "utf8"),
    );
  await goldenObjectVectors();
  await malformedObjectMetadata();
  const api = await registeredObjectApi();
  const via = async (
    action,
    input,
    operation_id = randomUUID(),
    actor = api.principal,
  ) => {
    const request = decodeSourceRequest(
      encodeSourceRequest({
        protocol_version: 1,
        scope,
        operation_id,
        action,
        input,
      }),
    );
    const result = await api.service.invoke(action, request, actor);
    return decodeSourceResponse(
      encodeSourceResponse(
        { protocol_version: 1, operation_id, result },
        { action },
      ),
      { action },
    ).result;
  };
  const registeredPayload = Buffer.from("registered consumer bytes"),
    registered = await via("source.objects.put", {
      kind: "blob",
      payload_base64: registeredPayload.toString("base64"),
    });
  assert.equal(registered.state, "VERIFIED");
  assert.equal(registered.object_id, sourceObjectId("blob", registeredPayload));
  assert.deepEqual(
    Buffer.from(
      (await via("source.objects.read", { object_id: registered.object_id }))
        .payload_base64,
      "base64",
    ),
    registeredPayload,
  );
  const inspected = await via("source.objects.inspect", {
    object_id: registered.object_id,
  });
  assert.equal(inspected.object_id, registered.object_id);
  assert.equal(inspected.state, "VERIFIED");
  assert.equal(inspected.storage_key, undefined);
  assert.equal(inspected.backend_upload_id, undefined);
  assert.equal(inspected.multipart_parts, undefined);
  await assert.rejects(
    via("source.objects.put", {
      kind: "blob",
      payload_base64: "not canonical!",
    }),
    (e) => e.code === "INVALID_ENCODING",
  );
  await pool.query(
    "UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE principal_id=$1",
    [api.principal.id],
  );
  const beforeRevoked = requests.length;
  await assert.rejects(
    via("source.objects.read", { object_id: registered.object_id }),
    (e) => e.code === "SCOPE_DENIED",
  );
  assert.equal(requests.length, beforeRevoked);
  checks.push(
    "registered source.objects put, read and inspect use real PostgreSQL capability authorization and wire codecs; revoked consumers cannot read",
  );
  await multipartUploadFaults();
  await sharedChildReservations();

  const file = await store.putFile(
      scope,
      Buffer.from("exact executable bytes\n"),
    ),
    symlink = await store.put(scope, "blob", Buffer.from("../core/main.ts"));
  assert.equal(
    (await store.readFile(scope, file.object_id)).toString(),
    "exact executable bytes\n",
  );
  assert.notEqual(
    sourceObjectId("blob", Buffer.from("same")),
    sourceObjectId("chunk", Buffer.from("same")),
  );
  checks.push(
    "typed envelopes and file descriptor reconstruct exact independent payload",
  );
  const binary = Buffer.alloc(4194304 + 17, 0xa5);
  binary.set(Buffer.from("final short chunk"), 4194304);
  const large = await store.putFile(scope, binary);
  assert.deepEqual(
    await store.readFile(scope, large.object_id, {
      offset: 4194296,
      length: 25,
    }),
    binary.subarray(4194296),
  );
  assert.deepEqual(await store.readFile(scope, large.object_id), binary);
  checks.push(
    "chunked binary descriptor reconstructs whole payload and cross-chunk range",
  );
  const entry = {
    name: "main.ts",
    kind: "file",
    mode: "100755",
    object_id: file.object_id,
  };
  let root = await trees.empty(scope);
  root = (
    await trees.patch(scope, root, [
      { path: "core/main.ts", operation: "put", ...entry },
      {
        path: "link",
        operation: "put",
        kind: "symlink",
        mode: "120000",
        object_id: symlink.object_id,
      },
    ])
  ).root_tree_id;
  assert.equal(
    (await trees.lookup(scope, root, "core/main.ts")).mode,
    "100755",
  );
  assert.equal((await trees.lookup(scope, root, "link")).kind, "symlink");
  assert.equal((await trees.list(scope, root, { limit: 1 })).entries.length, 1);
  checks.push("nested sparse tree preserves executable and symlink metadata");
  const metrics = [];
  for (const count of [512, 4096]) {
    const entries = Array.from({ length: count }, (_, n) => ({
        ...entry,
        name: "entry-" + String(n).padStart(6, "0"),
      })),
      initial = await trees.fromEntries(scope, entries),
      before = requests.length;
    const updated = await trees.patch(scope, initial.root_tree_id, [
      {
        path: "entry-000123",
        operation: "put",
        kind: "file",
        mode: "100644",
        object_id: file.object_id,
      },
    ]);
    const calls = requests.length - before;
    console.log(
      JSON.stringify({
        phase: "patch-metrics",
        count,
        ...updated.metrics,
        calls,
      }),
    );
    assert(
      updated.metrics.nodes_read <= 2 * Buffer.byteLength("entry-000123") + 2 &&
        updated.metrics.nodes_written <=
          2 * Buffer.byteLength("entry-000123") + 2 &&
        calls < 160,
      { count, ...updated.metrics, calls },
    );
    assert.equal(
      (await trees.lookup(scope, updated.root_tree_id, "entry-000123")).mode,
      "100644",
    );
    assert.equal(
      (await trees.lookup(scope, initial.root_tree_id, "entry-000123")).mode,
      "100755",
    );
    metrics.push({
      entries: count,
      ...updated.metrics,
      backend_requests: calls,
    });
    let cursor,
      seen = [];
    do {
      const page = await trees.list(scope, updated.root_tree_id, {
        limit: 127,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.entries.map((e) => e.name));
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(seen.length, count);
    assert.deepEqual(
      seen,
      entries.map((e) => e.name),
    );
    const restored = await trees.patch(scope, updated.root_tree_id, [
      {
        path: "entry-000123",
        operation: "put",
        kind: "file",
        mode: "100755",
        object_id: file.object_id,
      },
    ]);
    assert.equal(restored.root_tree_id, initial.root_tree_id);
    if (count === 512) {
      const reversed = await trees.fromEntries(scope, [...entries].reverse());
      assert.equal(reversed.root_tree_id, initial.root_tree_id);
      const added = await trees.patch(scope, initial.root_tree_id, [
        {
          path: "temporary-entry",
          operation: "put",
          kind: "file",
          mode: "100644",
          object_id: file.object_id,
        },
      ]);
      const removed = await trees.patch(scope, added.root_tree_id, [
        { path: "temporary-entry", operation: "remove" },
      ]);
      assert.equal(removed.root_tree_id, initial.root_tree_id);
    }
  }
  metrics.push(...(await nestedBoundedWork(entry, file)));
  checks.push(
    "fixed patch touches bounded radix paths across512 and4096 entries; pagination has no duplicates or omissions",
  );
  checks.push(
    "radix insertion order and add-delete normalization reproduce the exact canonical root",
  );
  const lost = Buffer.from("lost response payload"),
    operation = randomUUID(),
    id = sourceObjectId("blob", lost);
  fixture.faults.losePut = true;
  fixture.faults.unavailableReads = 1;
  await assert.rejects(
    store.put(scope, "blob", lost, operation),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  const upload = await catalog.begin(scope, {
    operation_id: operation,
    object_id: id,
    kind: "blob",
    size_bytes: String(
      Buffer.byteLength(
        "hyperfide-source-control\0v1\0blob\0" + lost.length + "\0",
      ) + lost.length,
    ),
  });
  assert.equal(upload.status, "UNKNOWN");
  await store.completeUpload(scope, upload.upload_id);
  assert.equal(
    (await store.read(scope, id)).payload.toString(),
    lost.toString(),
  );
  assert.equal(
    requests.filter(
      (r) => r.method === "PUT" && r.key.endsWith(upload.incarnation_id),
    ).length,
    1,
  );
  checks.push(
    "lost PUT acknowledgment remains UNKNOWN until exact readback verifies without another PUT",
  );
  await assert.rejects(
    store.put(scope, "blob", Buffer.from("changed request"), operation),
    (e) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  fixture.faults.corrupt = true;
  await assert.rejects(
    store.read(scope, id),
    (e) => e.code === "OBJECT_INTEGRITY",
  );
  fixture.faults.corrupt = false;
  const internal = await store.put(
    scope,
    "tree-leaf",
    encodeTreeNode({
      kind: "tree-leaf",
      prefix: "6",
      entries: [entry],
      count: 1,
    }),
  );
  await assert.rejects(
    db.transaction((tx) =>
      protectSourceRoot(tx, scope, internal.object_id, randomUUID()),
    ),
    (e) => e.code === "INVALID_TREE",
  );
  await assert.rejects(
    trees.patch(scope, internal.object_id, []),
    (e) => e.code === "INVALID_TREE",
  );
  await assert.rejects(
    store.put(
      scope,
      "tree-leaf",
      encodeTreeNode({
        kind: "tree-leaf",
        prefix: "",
        entries: [
          {
            name: "invalid-dir",
            kind: "directory",
            mode: "040000",
            object_id: internal.object_id,
          },
        ],
        count: 1,
      }),
    ),
    (e) => e.code === "INVALID_TREE",
  );
  checks.push(
    "internal radix node cannot become a revision root, directory root or directory entry",
  );
  const beforeDenied = requests.length;
  await assert.rejects(
    store.read({ ...scope, security_domain_id: randomUUID() }, id),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  assert.equal(requests.length, beforeDenied);
  checks.push(
    "corruption, changed idempotent request and cross-domain guesses are refused",
  );
  const missing = "sha256:" + "a".repeat(64);
  await assert.rejects(
    store.put(
      scope,
      "tree-leaf",
      encodeTreeNode({
        kind: "tree-leaf",
        prefix: "",
        entries: [{ ...entry, object_id: missing }],
        count: 1,
      }),
    ),
    (e) => e.code === "INVALID_TREE",
  );
  const pin = await db.transaction((tx) =>
    protectSourceRoot(tx, scope, root, randomUUID()),
  );
  assert.equal(pin.object_id, root);
  const pins = await pool.query(
    "SELECT count(*)::int AS count FROM hyperfide.source_object_pins WHERE owner_kind='OBJECT'",
  );
  assert(pins.rows[0].count > 0);
  checks.push(
    "verified parents and revision roots acquire real durable exact-incarnation pins",
  );
  const fenced = await trees.empty({ ...scope, repository_id: randomUUID() });
  const fencedRow = (
    await pool.query(
      "SELECT * FROM hyperfide.source_native_objects WHERE object_id=$1 AND repository_id<>$2",
      [fenced, scope.repository_id],
    )
  ).rows[0];
  const fencedScope = { ...scope, repository_id: fencedRow.repository_id };
  await pool.query(
    "UPDATE hyperfide.source_object_placements SET state='DELETE_PENDING' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4",
    [
      scope.organisation_id,
      fencedScope.repository_id,
      scope.security_domain_id,
      fenced,
    ],
  );
  await assert.rejects(
    db.transaction((tx) =>
      protectSourceRoot(tx, fencedScope, fenced, randomUUID()),
    ),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  await assert.rejects(
    pool.query(
      "UPDATE hyperfide.source_native_objects SET kind='blob' WHERE organisation_id=$1 AND repository_id=$2 AND object_id=$3",
      [scope.organisation_id, scope.repository_id, root],
    ),
    (e) => e.code === "23514",
  );
  checks.push(
    "physical placement deletion fence prevents new root pins; native identity mutation rejected in PostgreSQL",
  );
  assert(
    requests
      .filter((r) => !r.query.uploadId && !Object.hasOwn(r.query, "uploads"))
      .every((r) => ["PUT", "GET"].includes(r.method)),
  );
  assert(
    requests
      .filter((r) => r.method === "POST")
      .every(
        (r) => r.query.uploads === "" || typeof r.query.uploadId === "string",
      ),
  );
  assert(requests.every((r) => !Object.hasOwn(r.query, "list-type")));
  assert(requests.every((r) => r.key.startsWith("/fixture-bucket/source/v1/")));
  checks.push(
    "all reconstruction uses identified GET/conditionalPUT without LIST or repository materialization",
  );
  let live = {
    status: "UNRUN",
    reason: "run with --live-s3 for configured backend",
  };
  if (process.argv.includes("--live-s3")) {
    try {
      const actual = new S3SourceObjectBackend(
          sourceS3Configuration(process.env),
        ),
        bytes = Buffer.from("hyperfide source S3 integration " + randomUUID()),
        object = sourceObjectId("blob", bytes),
        incarnation = randomUUID(),
        domain = randomUUID(),
        key =
          "source/v1/" +
          domain +
          "/blob/" +
          object.slice(7, 9) +
          "/" +
          object.slice(7) +
          "/" +
          incarnation;
      const envelope = Buffer.concat([
        Buffer.from(
          "hyperfide-source-control\0v1\0blob\0" + bytes.length + "\0",
        ),
        bytes,
      ]);
      const put = await actual.put(key, envelope),
        observed = await actual.read(key, envelope.length);
      assert.equal(observed.state, "PRESENT");
      assert.deepEqual(observed.bytes, envelope);
      assert.equal(
        await actual.put(key, Buffer.from("different bytes")),
        "EXISTS",
      );
      const cleanup = await actual.delete(key, object, envelope.length);
      assert.equal(cleanup, "ABSENT");
      const multipartScope = {
          organisation_id: randomUUID(),
          repository_id: randomUUID(),
          security_domain_id: randomUUID(),
        },
        multipartStore = new SourceObjectService(catalog, actual),
        multipartPayload = Buffer.from("native multipart " + randomUUID()),
        multipartEnvelope = Buffer.from(
          "hyperfide-source-control\0v1\0blob\0" +
            multipartPayload.length +
            "\0" +
            multipartPayload,
        ),
        multipartObject = sourceObjectId("blob", multipartPayload);
      const upload = await catalog.begin(multipartScope, {
          operation_id: randomUUID(),
          object_id: multipartObject,
          kind: "blob",
          size_bytes: String(multipartEnvelope.length),
        }),
        started = await actual.initiateMultipart(upload.storage_key);
      assert.equal(started.state, "ACKNOWLEDGED");
      await catalog.beginMultipart(
        multipartScope,
        upload.upload_id,
        started.upload_id,
      );
      const part = await actual.uploadPart(
        upload.storage_key,
        started.upload_id,
        1,
        multipartEnvelope,
      );
      assert.equal(part.state, "ACKNOWLEDGED");
      await catalog.recordMultipartPart(
        multipartScope,
        upload.upload_id,
        started.upload_id,
        {
          part: 1,
          etag: part.etag,
          size_bytes: String(multipartEnvelope.length),
        },
      );
      assert.equal(
        await actual.completeMultipart(upload.storage_key, started.upload_id, [
          { part: 1, etag: part.etag },
        ]),
        "ACKNOWLEDGED",
      );
      await multipartStore.completeUpload(multipartScope, upload.upload_id);
      assert.deepEqual(
        (await multipartStore.read(multipartScope, multipartObject)).payload,
        multipartPayload,
      );
      assert.equal(
        await actual.delete(
          upload.storage_key,
          multipartObject,
          multipartEnvelope.length,
        ),
        "ABSENT",
      );
      checks.push(
        "configured real S3 multipart completion becomes native verified content only after independent exact-byte readback",
      );
      live = {
        status: "PASS",
        backend: actual.identity,
        put_outcome: put,
        key,
        object_id: object,
        cleanup,
        multipart: {
          object_id: multipartObject,
          verified: true,
          cleanup: "ABSENT",
        },
      };
    } catch (error) {
      if (error.code !== "SOURCE_STORAGE_CONFIG") throw error;
      live = {
        status: "UNRUN",
        reason: "Configured source S3 backend is unavailable",
      };
    }
  }
  assert.deepEqual(await packSnapshot(), packsBefore);
  assert.deepEqual(packEvents, []);
  assert.deepEqual(spawnedProcesses, []);
  checks.push(
    "no child process (including git) spawned and no pack file written during component execution",
  );
  const receipt = {
    status: live.status === "PASS" ? "PASS" : "COMPONENT_PASS",
    checks,
    metrics,
    backend: s3.identity,
    backend_requests: requests.length,
    no_git: {
      spawned_processes: spawnedProcesses.length,
      pack_writes: packEvents.length,
    },
    live_s3: live,
  };
  const output =
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/1.1";
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    output + "/receipt.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
  if (process.argv.includes("--live-s3") && live.status !== "PASS")
    process.exitCode = 77;
} finally {
  processObserver.disable();
  for (const watcher of packWatchers) watcher.close();
  await pool.end();
  await fixture.close();
}

async function goldenObjectVectors() {
  const vectors = JSON.parse(
    await fs.readFile(
      "tests/hyperfide/cases/source_control/fixtures/contracts-v1.json",
      "utf8",
    ),
  ).vectors;
  for (const name of [
    "blob-file-descriptor",
    "chunked-file-descriptor",
    "tree-index",
    "empty-tree",
  ])
    assert(vectors.some((vector) => vector.name === name));
  for (const vector of vectors) {
    const payload = Buffer.from(vector.payload_hex, "hex");
    assert.equal(
      Buffer.from(canonicalEnvelope(vector.kind, payload)).toString("hex"),
      vector.envelope_hex,
      vector.name,
    );
    assert.equal(
      sourceObjectId(vector.kind, payload),
      vector.object_id,
      vector.name,
    );
    if (!vector.decoded) continue;
    const decoded =
      vector.kind === "file"
        ? decodeFileDescriptor(payload)
        : decodeTreeNode(vector.kind, payload);
    assert.deepEqual(decoded, vector.decoded, vector.name);
    assert.equal(
      (vector.kind === "file"
        ? encodeFileDescriptor(decoded)
        : encodeTreeNode(decoded)
      ).toString("hex"),
      vector.payload_hex,
      vector.name,
    );
  }
  const goldenScope = { ...scope, repository_id: randomUUID() };
  await store.put(goldenScope, "blob", Buffer.from([0, 1, 255]));
  for (const bytes of [
    Buffer.alloc(FILE_CHUNK_BYTES, 0x61),
    Buffer.alloc(17, 0x7a),
  ])
    await store.put(goldenScope, "chunk", bytes);
  for (const vector of vectors.filter((v) => v.decoded)) {
    const row = await store.put(
      goldenScope,
      vector.kind,
      Buffer.from(vector.payload_hex, "hex"),
    );
    assert.equal(row.object_id, vector.object_id);
    assert.deepEqual(
      (await store.read(goldenScope, row.object_id)).payload,
      Buffer.from(vector.payload_hex, "hex"),
    );
  }
  assert.equal(
    await trees.empty(goldenScope),
    vectors.find((v) => v.name === "empty-tree").object_id,
  );
  checks.push(
    "shared golden blob and chunked file descriptors, radix leaves and index, and empty root match exact bytes and ids through storage",
  );
}
async function malformedObjectMetadata() {
  const id = sourceObjectId("blob", Buffer.from("malformed child")),
    digest = "sha256:" + "0".repeat(64),
    file = [
      1,
      String(FILE_CHUNK_BYTES + 1),
      digest,
      [
        "chunks",
        [
          [id, String(FILE_CHUNK_BYTES)],
          [id, "1"],
        ],
      ],
    ];
  assert.throws(
    () => decodeFileDescriptor(Buffer.from(" " + JSON.stringify(file))),
    (e) => e.code === "NON_CANONICAL_OBJECT",
  );
  for (const chunks of [
    [
      [id, "1"],
      [id, String(FILE_CHUNK_BYTES)],
    ],
    [
      [id, String(FILE_CHUNK_BYTES)],
      [id, "0"],
    ],
    [
      [id, String(FILE_CHUNK_BYTES)],
      [id, "2"],
    ],
  ])
    assert.throws(
      () =>
        decodeFileDescriptor(
          canonicalBytes([
            1,
            String(FILE_CHUNK_BYTES + 1),
            digest,
            ["chunks", chunks],
          ]),
        ),
      (e) => e.code === "INVALID_FILE",
    );
  const entry = (name) => [name, "file", "100644", id];
  assert.throws(
    () => decodeTreeNode("tree-leaf", Buffer.from('[1, "",[]]')),
    (e) => e.code === "NON_CANONICAL_OBJECT",
  );
  for (const entries of [
    [entry("z"), entry("a")],
    [entry("a"), entry("a")],
  ])
    assert.throws(
      () => decodeTreeNode("tree-leaf", canonicalBytes([1, "", entries])),
      (e) => e.code === "INVALID_TREE",
    );
  for (const value of [
    [1, "", "257", [["g", id, "257"]]],
    [
      1,
      "",
      "258",
      [
        ["6", id, "128"],
        ["7", id, "129"],
      ],
    ],
    [
      1,
      "",
      "257",
      [
        ["7", id, "128"],
        ["6", id, "129"],
      ],
    ],
    [
      1,
      "",
      "257",
      [
        ["6", id, "128"],
        ["6", id, "129"],
      ],
    ],
    [1, "g", "257", [["6", id, "257"]]],
  ])
    assert.throws(
      () => decodeTreeNode("tree-index", canonicalBytes(value)),
      (e) => e.code === "INVALID_TREE",
    );
  checks.push(
    "malformed file and tree tuples refuse noncanonical bytes, chunk lengths, leaf ordering and duplicates, radix digits and count mismatches with exact typed codes",
  );
}
async function registeredObjectApi() {
  const principalId = randomUUID(),
    credentialId = randomUUID(),
    expires_at = new Date(Date.now() + 3600000).toISOString(),
    capabilityId = randomUUID(),
    values = [
      scope.organisation_id,
      scope.repository_id,
      scope.security_domain_id,
    ];
  await pool.query(
    "INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,'source-v1')",
    values,
  );
  await pool.query(
    "INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'human',1,'owned-component','source-control','owned-component',$6)",
    [...values, credentialId, principalId, expires_at],
  );
  await pool.query(
    "INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'human',1,'source-v1',$7,ARRAY[''],$8)",
    [
      ...values,
      capabilityId,
      principalId,
      credentialId,
      ["source.objects.put", "source.objects.read", "source.objects.inspect"],
      expires_at,
    ],
  );
  const principal = {
    id: principalId,
    credential_id: credentialId,
    organisation_id: scope.organisation_id,
    kind: "human",
    expires_at,
    async assertCurrent(tx) {
      const rows = await tx.query(
        "SELECT 1 FROM hyperfide.source_principal_credentials WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND credential_id=$4 AND principal_id=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
        [...values, credentialId, principalId],
      );
      assert.equal(rows.rowCount, 1);
    },
  };
  const service = createSourceApi({
    objects: new SourceObjectService(catalog, s3, { multipart_part_bytes: 32 }),
    trees,
    metadata: new SourceMetadata(pool),
    cursorKey: randomBytes(32),
    authorize: (request) =>
      db.transaction((tx) => authorizeSource(tx, request)),
  });
  for (const action of [
    "source.objects.put",
    "source.objects.read",
    "source.objects.inspect",
  ])
    assert(service.actions.includes(action));
  return { service, principal };
}
async function multipartUploadFaults() {
  const multipartScope = { ...scope, repository_id: randomUUID() },
    options = { multipart_part_bytes: 256 },
    multipartStore = new SourceObjectService(catalog, s3, options),
    payload = Buffer.alloc(900, 0x5b),
    operation = randomUUID(),
    object_id = sourceObjectId("blob", payload);
  const request = {
    operation_id: operation,
    object_id,
    kind: "blob",
    size_bytes: String(canonicalEnvelope("blob", payload).length),
  };
  fixture.faults.loseComplete = true;
  fixture.faults.unavailableReads = 1;
  await assert.rejects(
    multipartStore.put(multipartScope, "blob", payload, operation),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  const upload = await catalog.begin(multipartScope, request);
  assert.equal(upload.status, "UNKNOWN");
  assert.equal(upload.state, "UPLOADING");
  assert(upload.backend_upload_id);
  assert.equal(
    upload.multipart_parts.length,
    Math.ceil(Number(upload.size_bytes) / 256),
  );
  assert.equal(
    upload.multipart_parts.reduce((n, p) => n + Number(p.size_bytes), 0),
    Number(upload.size_bytes),
  );
  await catalog.recordMultipartPart(
    multipartScope,
    upload.upload_id,
    upload.backend_upload_id,
    upload.multipart_parts[0],
  );
  await assert.rejects(
    catalog.beginMultipart(multipartScope, upload.upload_id, randomUUID()),
    (e) => e.code === "MULTIPART_CONFLICT",
  );
  await assert.rejects(
    catalog.recordMultipartPart(
      multipartScope,
      upload.upload_id,
      upload.backend_upload_id,
      { ...upload.multipart_parts[0], etag: "changed" },
    ),
    (e) => e.code === "MULTIPART_CONFLICT",
  );
  await assert.rejects(
    multipartStore.read(multipartScope, object_id),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  const before = requests.length,
    restartedCatalog = new PostgresSourceObjectCatalog(db),
    restarted = new SourceObjectService(
      restartedCatalog,
      new S3SourceObjectBackend(fixture.config),
      options,
    );
  assert.deepEqual(
    (await restartedCatalog.upload(multipartScope, upload.upload_id))
      .multipart_parts,
    upload.multipart_parts,
  );
  fixture.faults.corrupt = true;
  await assert.rejects(
    restarted.completeUpload(multipartScope, upload.upload_id),
    (e) => e.code === "OBJECT_INTEGRITY",
  );
  fixture.faults.corrupt = false;
  assert.equal(
    (await restartedCatalog.upload(multipartScope, upload.upload_id)).status,
    "UNKNOWN",
  );
  await restarted.completeUpload(multipartScope, upload.upload_id);
  assert.deepEqual(
    (await restarted.read(multipartScope, object_id)).payload,
    payload,
  );
  assert(requests.slice(before).every((r) => r.method === "GET"));
  assert.equal(
    (await restartedCatalog.upload(multipartScope, upload.upload_id)).status,
    "VERIFIED",
  );
  const missingPayload = Buffer.alloc(901, 0x6b),
    missingOperation = randomUUID(),
    missingId = sourceObjectId("blob", missingPayload),
    missingEnvelope = Buffer.from(canonicalEnvelope("blob", missingPayload));
  fixture.faults.missingPart = 2;
  await assert.rejects(
    multipartStore.put(
      multipartScope,
      "blob",
      missingPayload,
      missingOperation,
    ),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  const missing = await catalog.begin(multipartScope, {
    operation_id: missingOperation,
    object_id: missingId,
    kind: "blob",
    size_bytes: String(missingEnvelope.length),
  });
  assert.equal(missing.status, "UNKNOWN");
  assert.deepEqual(
    missing.multipart_parts.map((p) => p.part),
    [1],
  );
  await assert.rejects(
    restarted.completeUpload(multipartScope, missing.upload_id),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  await assert.rejects(
    catalog.verify(multipartScope, missing.upload_id, []),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  await assert.rejects(
    restarted.read(multipartScope, missingId),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  assert.equal(
    (await catalog.upload(multipartScope, missing.upload_id)).status,
    "UNKNOWN",
  );
  assert(!fixture.backendObjects.has("/fixture-bucket/" + missing.storage_key));
  assert(
    !requests.some(
      (r) =>
        r.key === "/fixture-bucket/" + missing.storage_key &&
        r.method === "POST" &&
        r.query.uploadId,
    ),
  );
  for (
    let offset = 256, part = 2;
    offset < missingEnvelope.length;
    offset += 256, part++
  ) {
    const bytes = missingEnvelope.subarray(offset, offset + 256),
      receipt = await s3.uploadPart(
        missing.storage_key,
        missing.backend_upload_id,
        part,
        bytes,
      );
    assert.equal(receipt.state, "ACKNOWLEDGED");
    await restartedCatalog.recordMultipartPart(
      multipartScope,
      missing.upload_id,
      missing.backend_upload_id,
      { part, etag: receipt.etag, size_bytes: String(bytes.length) },
    );
  }
  const repaired = await restartedCatalog.upload(
    multipartScope,
    missing.upload_id,
  );
  assert.equal(
    await s3.completeMultipart(
      missing.storage_key,
      missing.backend_upload_id,
      repaired.multipart_parts,
    ),
    "ACKNOWLEDGED",
  );
  await assert.rejects(
    restarted.read(multipartScope, missingId),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  await restarted.completeUpload(multipartScope, missing.upload_id);
  assert.deepEqual(
    (await restarted.read(multipartScope, missingId)).payload,
    missingPayload,
  );
  const dropped = Buffer.alloc(902, 0x7b),
    droppedOperation = randomUUID(),
    droppedId = sourceObjectId("blob", dropped);
  fixture.faults.dropCompletePart = 2;
  await assert.rejects(
    multipartStore.put(multipartScope, "blob", dropped, droppedOperation),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  const droppedUpload = await catalog.begin(multipartScope, {
    operation_id: droppedOperation,
    object_id: droppedId,
    kind: "blob",
    size_bytes: String(canonicalEnvelope("blob", dropped).length),
  });
  assert.equal(droppedUpload.status, "UNKNOWN");
  assert.equal(droppedUpload.multipart_parts.length, 4);
  await assert.rejects(
    restarted.completeUpload(multipartScope, droppedUpload.upload_id),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  await assert.rejects(
    restarted.read(multipartScope, droppedId),
    (e) => e.code === "OBJECT_NOT_READY",
  );
  checks.push(
    "multipart receipts survive service restart; lost completion, absent part receipt and backend missing part remain UNKNOWN until complete receipts and exact readback",
  );
}
async function sharedChildReservations() {
  const childScope = { ...scope, repository_id: randomUUID() },
    child = await store.putFile(
      childScope,
      Buffer.from("shared reserved child"),
    ),
    owners = [randomUUID(), randomUUID()];
  const parents = [];
  for (let i = 0; i < 2; i++) {
    const payload = encodeTreeNode({
        kind: "tree-leaf",
        prefix: "",
        entries: [
          {
            name: "owner-" + i,
            kind: "file",
            mode: "100644",
            object_id: child.object_id,
          },
        ],
        count: 1,
      }),
      operation_id = randomUUID();
    const parent = await catalog.begin(childScope, {
        operation_id,
        object_id: sourceObjectId("tree-leaf", payload),
        kind: "tree-leaf",
        size_bytes: String(canonicalEnvelope("tree-leaf", payload).length),
        owner_principal_id: owners[i],
      }),
      reservation_id = randomUUID();
    await db.transaction((tx) =>
      reserveSourceChild(tx, childScope, {
        reservation_id,
        parent_object_id: parent.object_id,
        parent_incarnation_id: parent.incarnation_id,
        child_object_id: child.object_id,
        child_incarnation_id: child.incarnation_id,
        position: 0,
      }),
    );
    parents.push({ parent, payload, operation_id, reservation_id });
  }
  fixture.faults.losePut = true;
  fixture.faults.unavailableReads = 1;
  await assert.rejects(
    store.put(
      childScope,
      "tree-leaf",
      parents[0].payload,
      parents[0].operation_id,
      owners[0],
    ),
    (e) => e.code === "OBJECT_UNAVAILABLE",
  );
  assert.equal(
    (await catalog.upload(childScope, parents[0].parent.upload_id)).status,
    "UNKNOWN",
  );
  await store.put(
    childScope,
    "tree-leaf",
    parents[1].payload,
    parents[1].operation_id,
    owners[1],
  );
  assert.equal(
    (
      await db.transaction((tx) =>
        reconcileSourceReservation(tx, childScope, parents[1].reservation_id),
      )
    ).state,
    "ADOPTED",
  );
  assert.deepEqual(
    await db.transaction((tx) =>
      reconcileSourceReservation(tx, childScope, parents[0].reservation_id),
    ),
    { state: "RESERVED", debt: "PARENT_OUTCOME_UNKNOWN" },
  );
  const retained = (
    await pool.query(
      "SELECT owner_kind,owner_id FROM hyperfide.source_object_pins WHERE repository_id=$1 AND object_id=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp())",
      [childScope.repository_id, child.object_id],
    )
  ).rows;
  assert(
    retained.some(
      (p) =>
        p.owner_kind === "HOLD" &&
        p.owner_id === "reservation:" + parents[0].reservation_id,
    ),
  );
  assert(
    retained.some(
      (p) =>
        p.owner_kind === "OBJECT" &&
        p.owner_id ===
          parents[1].parent.object_id + "/" + parents[1].parent.incarnation_id,
    ),
  );
  // Expire only upload leases so the collector must rely on both owners' child pins.
  await pool.query(
    "UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE repository_id=$1 AND object_id=$2 AND owner_kind='UPLOAD'",
    [childScope.repository_id, child.object_id],
  );
  const collector = new SourceCollector(db, s3);
  await collector.configure(childScope, {
    expected_generation: "0",
    minimum_age_seconds: 0,
    quarantine_seconds: 0,
    backup_until: new Date(0).toISOString(),
    backend_identity: s3.identity,
    independent_expiration: false,
  });
  const before = requests.length;
  for (let partition = 0; partition < 16; partition++) {
    const result = await collector.discover(childScope, {
      partition,
      limit: 256,
    });
    assert(!result.quarantined.some((o) => o.object_id === child.object_id));
    const collected = await collector.collect(childScope, {
      partition,
      limit: 256,
    });
    assert(!collected.results.some((o) => o.object_id === child.object_id));
  }
  assert(
    !requests
      .slice(before)
      .some(
        (r) =>
          r.method === "DELETE" &&
          r.key === "/fixture-bucket/" + child.storage_key,
      ),
  );
  assert.deepEqual(
    await store.readFile(childScope, child.object_id),
    Buffer.from("shared reserved child"),
  );
  checks.push(
    "two owners reserve the same direct child; an UNKNOWN parent retains its reservation while the other adopts, and the real collector cannot delete the pinned child",
  );
}
async function nestedBoundedWork(entry, file) {
  const metrics = [];
  for (const count of [1000, 10000, 100000]) {
    const directories = count / 100,
      entries = Array.from({ length: 100 }, (_, n) => ({
        ...entry,
        name: "file-" + String(n).padStart(3, "0"),
      })),
      leaf = await trees.fromEntries(scope, entries),
      children = Array.from({ length: directories }, (_, n) => ({
        name: "dir-" + String(n).padStart(4, "0"),
        kind: "directory",
        mode: "040000",
        object_id: leaf.root_tree_id,
      }));
    const directory = await trees.fromEntries(scope, children),
      nested = (
        await trees.fromEntries(scope, [
          {
            name: "project",
            kind: "directory",
            mode: "040000",
            object_id: directory.root_tree_id,
          },
        ])
      ).root_tree_id;
    for (const [root, target, depth] of [
      [leaf.root_tree_id, "file-042", 1],
      [directory.root_tree_id, "dir-0001/file-042", 2],
      [nested, "project/dir-0001/file-042", 3],
    ]) {
      const before = requests.length,
        updated = await trees.patch(scope, root, [
          {
            path: target,
            operation: "put",
            kind: "file",
            mode: "100644",
            object_id: file.object_id,
          },
        ]),
        calls = requests.length - before;
      // Each directory reads only its name radix path and writes that path back.
      const bound =
        1 +
        target
          .split("/")
          .reduce((n, name) => n + 2 * (2 * Buffer.byteLength(name) + 2), 0);
      assert(
        updated.metrics.nodes_read <= bound &&
          updated.metrics.nodes_written <= bound &&
          calls < 160,
        { count, depth, ...updated.metrics, calls, bound },
      );
      assert.equal(
        (await trees.lookup(scope, updated.root_tree_id, target)).mode,
        "100644",
      );
      assert.equal((await trees.lookup(scope, root, target)).mode, "100755");
      metrics.push({
        files: count,
        depth,
        ...updated.metrics,
        backend_requests: calls,
      });
    }
  }
  for (const count of [1000, 10000, 100000]) {
    const rows = metrics.filter((row) => row.files === count);
    assert(rows[1].nodes_read > rows[0].nodes_read);
    assert(rows[2].nodes_read > rows[1].nodes_read);
    assert(rows[1].nodes_written > rows[0].nodes_written);
    assert(rows[2].nodes_written > rows[1].nodes_written);
  }
  for (const depth of [1, 2, 3]) {
    const rows = metrics.filter((row) => row.depth === depth);
    assert(
      Math.max(...rows.map((row) => row.nodes_read)) -
        Math.min(...rows.map((row) => row.nodes_read)) <=
        2 * (2 * Buffer.byteLength("dir-0001") + 2),
    );
    assert(
      Math.max(...rows.map((row) => row.nodes_written)) -
        Math.min(...rows.map((row) => row.nodes_written)) <=
        2 * Buffer.byteLength("dir-0001") + 2,
    );
  }
  console.log(JSON.stringify({ phase: "nested-patch-metrics", metrics }));
  checks.push(
    "nested 1k, 10k and 100k file trees read and write only the changed directory and radix paths as depth increases",
  );
  return metrics;
}
