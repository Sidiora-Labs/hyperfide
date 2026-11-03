import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createNativeAcceptanceFixture } from "./native_source_acceptance_fixture.mjs";

const moduleRoot = process.env.SOURCE_CONTROL_MODULE_ROOT;
const live = process.env.HYPERFIDE_VIRTUAL_COMPONENT !== "1";
let serviceOptions;
if (live) {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { S3SourceObjectBackend, sourceS3Configuration } = await import(
    pathToFileURL(path.join(moduleRoot, "s3.js"))
  );
  serviceOptions = {
    backend: new S3SourceObjectBackend(sourceS3Configuration(process.env)),
  };
}
const fixture = await createNativeAcceptanceFixture({
  serviceOptions,
  checkPath: "src/cold.txt",
});
const profile = path.join(moduleRoot, "virtual-profile.json");
const before = process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE;
try {
  await fs.writeFile(
    profile,
    JSON.stringify({
      endpoint: fixture.endpoint,
      scope: fixture.scope,
      token: fixture.tokenFor(),
      denied_token: fixture.tokenFor("author", randomUUID()),
      qualification_backend: live ? "REAL_S3" : "S3_HTTP_FIXTURE",
    }),
    { mode: 0o600 },
  );
  process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE = profile;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve("tests/hyperfide/support/native_source_virtual_actor.mjs"),
    ],
    { stdio: ["inherit", "inherit", "inherit", "ipc"], env: process.env },
  );
  child.on("message", async (message) => {
    if (message.type !== "virtual-accept") return;
    try {
      const baseline = await fixture.client.revision(
        message.parent_revision_id,
      );
      const domain = await fixture.createDomain(baseline);
      const revision = await fixture.createRevision({
        root_tree_id: message.root_tree_id,
        parent_revision_ids: [message.parent_revision_id],
        message: "Virtual concurrent upstream",
      });
      const candidate = await fixture.createCandidate(revision, { domain });
      const qualification = await fixture.qualify(candidate);
      const accepted = await fixture.accept(candidate, qualification);
      child.send({ request_id: message.request_id, accepted });
    } catch (error) {
      child.send({
        request_id: message.request_id,
        error: error.code + ": " + error.message,
      });
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  if (before === undefined)
    delete process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE;
  else process.env.HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE = before;
  if (live && process.env.HYPERFIDE_VIRTUAL_RECEIPT) {
    const placements = await fixture.pool.query(
      "SELECT object_id,incarnation_id,storage_key,state FROM hyperfide.source_object_placements WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY storage_key",
      Object.values(fixture.scope),
    );
    await fs.writeFile(
      path.join(
        path.dirname(process.env.HYPERFIDE_VIRTUAL_RECEIPT),
        "retained-placements.json",
      ),
      JSON.stringify(
        { scope: fixture.scope, placements: placements.rows },
        null,
        2,
      ) + "\n",
    );
  }
  await fs.rm(profile, { force: true });
  await fixture.close();
}
