import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { authorityConfiguration, createAuthorityClient, digest, type AuthorityConfiguration, type Receipt } from "../src/index.js";

const configuration = (): AuthorityConfiguration => JSON.parse(process.env.HYPERFIDE_AUTHORITY_TEST_CONFIG!);
const identity = () => ({operationId: randomUUID(), idempotencyKey: randomUUID()});

describe("signed authority HTTPS client against control dist", () => {
  test("unset URL does not require keys", () => {
    expect(authorityConfiguration({})).toBeUndefined();
    expect(() => authorityConfiguration({HYPERFIDE_AUTHORITY_URL: "https://localhost"})).toThrow("Missing");
  });
  test("service allow-list accepts only its configured operator credential UUIDs", async () => {
    const config = configuration(), client = await createAuthorityClient(config);
    expect(await client.operator()).toMatchObject({role: "OPERATOR", credential_id: config.credentialId});
    expect(await client.health()).toEqual({status: "ready"});
    const unknown = await createAuthorityClient({...config, credentialId: randomUUID()});
    await expect(unknown.operator()).rejects.toMatchObject({code: "AUTH_INVALID"});
    const unlisted = await createAuthorityClient(JSON.parse(process.env.HYPERFIDE_AUTHORITY_TEST_UNLISTED!));
    await expect(unlisted.operator()).rejects.toMatchObject({code: "AUTH_SCOPE_DENIED"});
  });
  test("receipt and evidence batch persists, replays and rejects conflicting transaction identities", async () => {
    const client = await createAuthorityClient(configuration());
    const bytes = Buffer.from("authority client qualification evidence");
    const receipt: Receipt = {id: randomUUID(), kind: "lane", subject: "6.2", commit: "a".repeat(40),
      evidence_digest: digest(bytes), details: {exit: 0, verify_cmd: "test", duration_ms: 1}};
    const writes = [{kind: "receipt" as const, receipt},
      {kind: "evidence" as const, digest: digest(bytes), bytes_b64: bytes.toString("base64url")}];
    const operation = identity();
    expect(await client.receipt(receipt.id)).toBeNull();
    expect(await client.transaction(writes, operation)).toEqual({committed: true, count: 2});
    expect(await client.transaction(writes, operation)).toEqual({committed: true, count: 2});
    expect(await client.receipt(receipt.id)).toEqual(receipt);
    expect(await client.evidence(digest(bytes))).toEqual({digest: digest(bytes), bytes_b64: bytes.toString("base64url")});
    await expect(client.transaction([{kind: "receipt", receipt: {...receipt, subject: "changed"}}], operation))
      .rejects.toMatchObject({code: "IDEMPOTENCY_CONFLICT"});
    await expect(client.transaction([{kind: "receipt", receipt: {...receipt, subject: "changed"}}], identity()))
      .rejects.toMatchObject({code: "AUTHORITY_RECORD_CONFLICT"});
  });
  test("a conflicting batch rolls back earlier writes", async () => {
    const client = await createAuthorityClient(configuration());
    const receipt: Receipt = {id: randomUUID(), kind: "publication", subject: "wave6", commit: "b".repeat(40),
      evidence_digest: digest("publication"), details: {observed: true}};
    await client.transaction([{kind: "receipt", receipt}], identity());
    const bytes = Buffer.from("must roll back");
    await expect(client.transaction([
      {kind: "evidence", digest: digest(bytes), bytes_b64: bytes.toString("base64url")},
      {kind: "receipt", receipt: {...receipt, commit: "c".repeat(40)}},
    ], identity())).rejects.toMatchObject({code: "AUTHORITY_RECORD_CONFLICT"});
    expect(await client.evidence(digest(bytes))).toBeNull();
  });
  test("deadline bounds an actual service request waiting on PostgreSQL", async () => {
    const require = createRequire(process.env.HYPERFIDE_AUTHORITY_TEST_ROOT! + "/core/control-plane/package.json");
    const {Client} = require("pg");
    const blocker = new Client({connectionString: process.env.HYPERFIDE_AUTHORITY_TEST_DATABASE_URL});
    const config = configuration();
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT credential_id FROM hyperfide.identity_principals WHERE credential_id=$1 FOR UPDATE", [config.credentialId]);
      const client = await createAuthorityClient({...config, deadlineMs: 100});
      const started = performance.now();
      await expect(client.health()).rejects.toMatchObject({code: "OUTCOME_UNKNOWN"});
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });
});
