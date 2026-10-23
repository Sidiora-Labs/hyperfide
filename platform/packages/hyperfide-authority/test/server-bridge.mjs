import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createAuthorityBridge, registerAuthorityBridge } from "../../../apps/server/src/authority-bridge.ts";
import { createAuthorityClient, digest } from "../src/index.ts";

const root = process.env.HYPERFIDE_AUTHORITY_TEST_ROOT;
const { Hono } = createRequire(`${root}/platform/apps/server/package.json`)("hono");
const config = JSON.parse(process.env.HYPERFIDE_AUTHORITY_TEST_CONFIG);
const env = {
  HYPERFIDE_AUTHORITY_URL: config.url,
  HYPERFIDE_AUTHORITY_CA_FILE: config.caFile,
  HYPERFIDE_AUTHORITY_KEY_FILE: config.keyFile,
  HYPERFIDE_AUTHORITY_CREDENTIAL_ID: config.credentialId,
  HYPERFIDE_AUTHORITY_RUN_ID: config.runId,
};
const app = new Hono();
registerAuthorityBridge(app, createAuthorityBridge(env));
assert.equal((await (await app.request("/authority/operator")).json()).credential_id, config.credentialId);
assert.deepEqual(await (await app.request("/authority/status")).json(), { status: "ready" });
const client = await createAuthorityClient(config);
for (const kind of ["lane", "publication"]) {
  const receipt = { id: randomUUID(), kind, subject: "server-bridge", commit: "d".repeat(40),
    evidence_digest: digest("observed"), details: { observed: true } };
  const body = JSON.stringify({ receipt, identity: { operationId: randomUUID(), idempotencyKey: randomUUID() } });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request(`/authority/receipts/${kind}`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { committed: true, count: 1 });
  }
  assert.deepEqual(await client.receipt(receipt.id), receipt);
}
const refused = new Hono();
registerAuthorityBridge(refused, createAuthorityBridge({ ...env, HYPERFIDE_AUTHORITY_CREDENTIAL_ID: randomUUID() }));
refused.get("/work", (c) => c.json({ ok: true }));
assert.equal((await refused.request("/work")).status, 403);
assert.deepEqual(await (await refused.request("/authority/status")).json(), { status: "unavailable" });
console.log("Authority server bridge: real operator, lane/publication receipts, replay and refusal passed");
