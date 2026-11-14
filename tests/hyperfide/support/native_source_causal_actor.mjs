import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "../../../core/control-plane/node_modules/pg/lib/index.js";
import { randomUUID } from "node:crypto";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";

const f = await createNativeAcceptanceFixture({
  actions: [
    "source.revisions.create",
    "source.revisions.read",
    "source.domains.create",
    "source.operations.read",
    "source.migration.refresh",
    "source.capabilities",
  ],
});
const checks = [];
const execute = promisify(execFile);
let replicaPool,
  replicaDirectory,
  replicaStarted = false;
const postgres = (name, args) =>
  execute(
    "runuser",
    [
      "-u",
      "postgres",
      "--",
      path.join(process.env.HYPERFIDE_PG_BIN, name),
      ...args,
    ],
    { timeout: 30000, maxBuffer: 1048576 },
  );
async function startReplica() {
  const primary = new URL(process.env.DATABASE_URL),
    socket = primary.searchParams.get("host");
  assert(
    socket?.startsWith("/tmp/hyperfide/hf-withpg-"),
    "Replica must belong to the owned PostgreSQL fixture",
  );
  replicaDirectory = await fs.mkdtemp("/tmp/hyperfide/hf-causal-replica-");
  const owner = await fs.stat(path.join(socket, "data"));
  await fs.chown(replicaDirectory, owner.uid, owner.gid);
  await fs.chmod(replicaDirectory, 0o700);
  const data = path.join(replicaDirectory, "data");
  await postgres("pg_basebackup", [
    "-h",
    socket,
    "-p",
    primary.port || "5432",
    "-U",
    decodeURIComponent(primary.username),
    "-D",
    data,
    "-R",
    "-X",
    "stream",
    "-c",
    "fast",
  ]);
  await fs.appendFile(
    path.join(data, "postgresql.auto.conf"),
    "\nunix_socket_directories='" +
      replicaDirectory +
      "'\nlisten_addresses=''\nport=5432\nhot_standby=on\nlog_statement='all'\n",
  );
  await postgres("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(replicaDirectory, "server.log"),
    "-w",
    "-t",
    "20",
    "start",
  ]);
  replicaStarted = true;
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("host", replicaDirectory);
  replicaPool = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    connectionTimeoutMillis: 200,
    query_timeout: 1000,
  });
  assert.equal(
    (await replicaPool.query("SELECT pg_is_in_recovery() AS replica")).rows[0]
      .replica,
    true,
  );
  f.service.metadata.options.replica = replicaPool;
  f.service.metadata.options.replica_wait_ms = 250;
}
async function waitForApplied(operation) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      (
        await replicaPool.query(
          "SELECT 1 FROM hyperfide.source_metadata_operations WHERE operation_id=$1 AND state='COMMITTED'",
          [operation],
        )
      ).rows.length
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Physical replica did not apply the committed producer receipt");
}
const token = f.base.causal_token;
const mutate = (change) => {
  const tuple = JSON.parse(Buffer.from(token, "base64url"));
  change(tuple);
  return Buffer.from(JSON.stringify(tuple)).toString("base64url");
};
const read = (causal_token = token, client = f.client) =>
  client.revision(f.base.revision_id, { causal_token });
const refused = async (code, body) =>
  assert.rejects(body, (error) => error.code === code, code);
try {
  await startReplica();
  await waitForApplied(f.base.operation_id);
  const replicaBase = await read();
  assert.equal(replicaBase.causal_route, "replica");
  const control = await replicaPool.connect();
  try {
    await control.query("SELECT pg_wal_replay_pause()");
    assert.equal(
      (await control.query("SELECT pg_get_wal_replay_pause_state() AS state"))
        .rows[0].state,
      "paused",
    );
    const dependent = await f.createRevision({
      root_tree_id: f.base.root_tree_id,
      message: "Receipt created while physical replica is paused",
    });
    assert.equal(
      (
        await control.query(
          "SELECT 1 FROM hyperfide.source_metadata_operations WHERE operation_id=$1",
          [dependent.operation_id],
        )
      ).rows.length,
      0,
    );
    const started = Date.now(),
      fallback = await f.client.revision(dependent.revision_id, {
        causal_token: dependent.causal_token,
      });
    assert.equal(fallback.revision_id, dependent.revision_id);
    assert.equal(fallback.causal_route, "primary");
    assert(Date.now() - started < 1500);
    await control.query("SELECT pg_wal_replay_resume()");
    await waitForApplied(dependent.operation_id);
    const applied = await f.client.revision(dependent.revision_id, {
      causal_token: dependent.causal_token,
    });
    assert.equal(applied.revision_id, dependent.revision_id);
    assert.equal(applied.causal_route, "replica");
    const occupied = await replicaPool.connect();
    try {
      const queued = Date.now(),
        bounded = await read();
      assert.equal(bounded.causal_route, "primary");
      assert(Date.now() - queued < 1500);
    } finally {
      occupied.release();
    }
  } finally {
    await control.query("SELECT pg_wal_replay_resume()");
    control.release();
  }
  const replicaLog = await fs.readFile(
    path.join(replicaDirectory, "server.log"),
    "utf8",
  );
  assert(
    replicaLog.includes("SELECT revision_id,root_tree_id,descriptor"),
    "Dependent revision reads must execute on the physical replica connection",
  );
  checks.push(
    "a real physical standby serves applied receipts, paused replay falls back to primary, and exhausted replica connections have a bounded primary fallback",
  );
  assert.equal((await read()).revision_id, f.base.revision_id);
  assert.equal(
    (await f.client.operation(f.base.operation_id, { causal_token: token }))
      .state,
    "SUCCEEDED",
  );
  checks.push(
    "SDK causal receipt option reaches authenticated HTTP and reads its committed revision and operation",
  );
  await refused("INVALID_CAUSAL_TOKEN", () =>
    read(
      mutate((v) => {
        v[1].repository_id = randomUUID();
      }),
    ),
  );
  await refused("STALE_CAUSAL_TOKEN", () =>
    read(
      mutate((v) => {
        v[2] = "0";
      }),
    ),
  );
  await refused("STALE_CAUSAL_TOKEN", () =>
    read(
      mutate((v) => {
        v[2] = "2";
      }),
    ),
  );
  await refused("INVALID_CAUSAL_TOKEN", () =>
    read(
      mutate((v) => {
        v[4] = "sha256:" + "f".repeat(64);
      }),
    ),
  );
  await refused("INVALID_CAUSAL_TOKEN", () =>
    read(Buffer.from("[1]").toString("base64url")),
  );
  await refused("CAUSAL_UNAVAILABLE", () =>
    read(
      mutate((v) => {
        v[3] = randomUUID();
      }),
    ),
  );
  await refused("CAUSAL_UNAVAILABLE", () => read(token, f.checkerClient));
  checks.push(
    "forged digest, malformed, other scope, earlier/future epoch, absent operation and other principal cannot imply a current causal read",
  );
  const pending = randomUUID();
  await f.pool.query(
    "INSERT INTO hyperfide.source_metadata_operations(organisation_id,repository_id,security_domain_id,principal_id,operation_id,action,idempotency_key,request_digest,state) VALUES($1,$2,$3,$4,$5,'source.revisions.create',$7,$6,'PENDING')",
    [
      ...Object.values(f.scope),
      f.roles.author.principal_id,
      pending,
      "sha256:" + "0".repeat(64),
      pending,
    ],
  );
  await refused("CAUSAL_UNAVAILABLE", () =>
    read(
      mutate((v) => {
        v[3] = pending;
      }),
    ),
  );
  const root = await f.service.objects.catalog.lookup(
    f.scope,
    f.base.root_tree_id,
  );
  const key = "/" + f.backend.config.bucket + "/" + root.storage_key,
    bytes = f.backend.backendObjects.get(key);
  assert(bytes);
  f.backend.backendObjects.delete(key);
  await refused("CAUSAL_UNAVAILABLE", () => read());
  f.backend.backendObjects.set(key, bytes);
  f.backend.faults.unavailableReads = 1;
  const started = Date.now();
  await refused("CAUSAL_UNAVAILABLE", () => read());
  assert(Date.now() - started < 5500);
  assert.equal((await read()).root_tree_id, f.base.root_tree_id);
  checks.push(
    "pending metadata, absent S3 root and unknown S3 observation fail explicitly within the causal deadline; recovered bytes permit reads",
  );
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1",
    [f.roles.author.capability_id],
  );
  await refused("SCOPE_DENIED", () => read());
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET revoked_at=NULL WHERE id=$1",
    [f.roles.author.capability_id],
  );
  checks.push("a receipt never substitutes for a current source capability");
  await f.pool.query(
    "INSERT INTO hyperfide.source_recovery_state(organisation_id,repository_id,security_domain_id,operation_id,deployment_id,external_epoch,state) VALUES($1,$2,$3,$4,$5,$6,'VERIFYING')",
    [...Object.values(f.scope), randomUUID(), randomUUID(), randomUUID()],
  );
  assert.equal(
    (await f.client.revision(f.base.revision_id)).revision_id,
    f.base.revision_id,
  );
  await refused("RECOVERY_NOT_READY", () => read());
  await f.pool.query(
    "UPDATE hyperfide.source_recovery_state SET state='READY'",
  );
  await refused("RECOVERY_NOT_READY", () => read());
  await f.pool.query("DELETE FROM hyperfide.source_recovery_state");
  checks.push(
    "restored metadata remains readable diagnostically but causal reads require verified recovery and current independent activation",
  );
  await f.pool.query(
    "UPDATE hyperfide.source_principal_credentials SET principal_kind='worker' WHERE credential_id=$1",
    [f.roles.author.credential_id],
  );
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET principal_kind='worker' WHERE id=$1",
    [f.roles.author.capability_id],
  );
  f.roles.author.kind = "worker";
  assert.equal((await read()).revision_id, f.base.revision_id);
  await refused("SCOPE_DENIED", () =>
    f.client.call(
      "source.migration.refresh",
      {},
      { operation_id: randomUUID(), idempotency_key: randomUUID() },
    ),
  );
  checks.push(
    "managed worker can perform authorized reads but cannot bypass migration refresh mutation admission",
  );
  await replicaPool.query("SELECT pg_wal_replay_pause()");
  f.roles.author.kind = "automation";
  await f.pool.query(
    "UPDATE hyperfide.source_principal_credentials SET principal_kind='automation' WHERE credential_id=$1",
    [f.roles.author.credential_id],
  );
  await f.pool.query(
    "UPDATE hyperfide.source_capabilities SET principal_kind='automation',authority_epoch=2 WHERE id=$1",
    [f.roles.author.capability_id],
  );
  await f.pool.query(
    "UPDATE hyperfide.source_authority_domains SET authority_epoch=2",
  );
  await f.pool.query(
    "UPDATE hyperfide.source_repositories SET authority_epoch=2",
  );
  assert.equal(
    (await f.client.revision(f.base.revision_id)).revision_id,
    f.base.revision_id,
  );
  await refused("STALE_CAUSAL_TOKEN", () => read());
  const newEpoch = await f.createRevision({
    root_tree_id: f.base.root_tree_id,
    message: "Current epoch with stale replica epoch",
  });
  await refused("STALE_CAUSAL_TOKEN", () =>
    f.client.revision(newEpoch.revision_id, {
      causal_token: newEpoch.causal_token,
    }),
  );
  checks.push(
    "current authorized reader can inspect history after authority advancement while the pre-transition causal token stays invalid",
  );
  const receipt = {
    schema_version: 1,
    status: "PASS",
    checks,
    scope:
      "actual HTTP, signed taskless SDK, PostgreSQL and SigV4 object transport",
    requests: f.backend.requests.length,
  };
  const output = path.resolve(
    process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR ?? "build/source-control/causal",
  );
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  for (const check of checks) console.log("causal-source: " + check);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  delete f.service.metadata.options.replica;
  if (replicaPool) await replicaPool.end();
  if (replicaStarted)
    await postgres("pg_ctl", [
      "-D",
      path.join(replicaDirectory, "data"),
      "-m",
      "fast",
      "-w",
      "-t",
      "20",
      "stop",
    ]);
  if (replicaDirectory)
    await fs.rm(replicaDirectory, { recursive: true, force: true });
  await f.close();
}
