import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseNeron,
  parsePackage,
  digest,
} from "../../../../../../contracts/fleet/index.mjs";
import { createGitSourceManifest } from "../../../../../../core/control-plane/dist/preparation/fleet_source.js";
import {
  resolveFleetMounts,
  materializeFleetMounts,
  assembleFleetWorkerSource,
  verifyFleetWorkerDependencies,
} from "../../../../../../core/control-plane/dist/preparation/fleet_mounts.js";
import { verifyConfigurationSnapshot } from "../../../../../../core/control-plane/dist/preparation/fleet_install_inventory.js";
import { SOURCE_ACTIONS } from "../../../../../../core/control-plane/dist/source_control/contracts.js";
import { SOURCE_AUTHORIZATION_ACTIONS } from "../../../../../../core/control-plane/dist/source_control/capabilities.js";
import { SOURCE_EVENT_ACTIONS } from "../../../../../../core/control-plane/dist/source_control/events.js";

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

export async function installerRefusals() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "hyperfide-install-refusals-"),
  );
  const assertions = {};
  const refused = async (name, code, action) => {
    await assert.rejects(action, (error) => error.code === code);
    assertions[name] = true;
  };
  try {
    const declaration = JSON.parse(
      await fs.readFile(
        path.join(ROOT, "core/control-plane/components/source-control.json"),
        "utf8",
      ),
    );
    assert.equal(new Set(declaration.actions).size, declaration.actions.length);
    assert.deepEqual(new Set(declaration.actions), new Set(SOURCE_ACTIONS));
    assert.equal(SOURCE_EVENT_ACTIONS.lifecycle, "source.lifecycle.read");
    for (const action of Object.values(SOURCE_EVENT_ACTIONS)) {
      assert.equal(declaration.actions.includes(action), true);
      assert.equal(SOURCE_AUTHORIZATION_ACTIONS.has(action), true);
    }
    assertions["installer.component-action-catalog-matches-factory"] = true;
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await fs.writeFile(
      path.join(repo, "main.js"),
      "export const installed = true;\n",
    );
    const git = (args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git(["init", "-q"]);
    git(["add", "."]);
    git([
      "-c",
      "user.name=InstallCase",
      "-c",
      "user.email=install@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "Pinned install refusal input",
    ]);
    const revision = "git:" + git(["rev-parse", "HEAD"]);
    const environment = path.join(root, "environment");
    const sourceText = (
      await fs.readFile(
        path.join(ROOT, "spec/hyperfide-source-control/examples/fleet/.neron"),
        "utf8",
      )
    )
      .replace("example = true", "example = false")
      .replace(
        "https://source.example.invalid/api/v1/source-control",
        "https://localhost/api/v1/source-control",
      )
      .replaceAll("git:" + "0".repeat(40), revision)
      .replaceAll("/sandbox", environment)
      .replace(/^read_scope = .*$/m, 'read_scope = ["main.js"]')
      .replace(/^write_scope = .*$/m, 'write_scope = ["main.js"]');
    const sourceConfig = parseNeron(sourceText);
    const packageText = (
      await fs.readFile(
        path.join(
          ROOT,
          "spec/hyperfide-source-control/examples/fleet/package.kvx",
        ),
        "utf8",
      )
    )
      .replace("example = true", "example = false")
      .replaceAll("git:" + "0".repeat(40), revision)
      .replaceAll("sha256:" + "0".repeat(64), digest("resolved refusal input"))
      .replaceAll("/sandbox", environment)
      .replace(
        /^config_digest = .*$/m,
        "config_digest = " + JSON.stringify(digest(sourceConfig)),
      )
      .replace(/^paths = .*$/m, 'paths = ["main.js"]');
    const manifest = parsePackage(packageText, { neron: sourceConfig });
    const source = await createGitSourceManifest({
      repositoryPath: repo,
      repository: sourceConfig.source.repository,
      revision,
      paths: ["main.js"],
    });
    const packagePath = path.join(root, "package.kvx"),
      sourcePath = path.join(root, ".neron"),
      envelopePath = path.join(root, "envelope.json");
    await fs.writeFile(packagePath, packageText, { mode: 0o600 });
    await fs.writeFile(sourcePath, sourceText, { mode: 0o600 });
    const plan = {
      package_digest: digest(manifest),
      source_config_digest: digest(sourceConfig),
      source_manifest_digest: source.digest,
    };
    const admission = {
      operation_id: "11111111-1111-4111-8111-111111111111",
      package_digest: digest(manifest),
      source_config_digest: digest(sourceConfig),
      source_manifest_digest: source.digest,
      plan_digest: digest(plan),
      source_revision: "git:" + "f".repeat(40),
      environment_id: sourceConfig.workspace.environment_id,
      environment_generation: sourceConfig.workspace.environment_generation,
      read_scope: sourceConfig.workspace.read_scope,
      write_scope: sourceConfig.workspace.write_scope,
    };
    await fs.writeFile(
      envelopePath,
      JSON.stringify({
        admission: { ...admission, admission_digest: digest(admission) },
        plan,
        authority_config_path: path.join(root, "unused-authority.json"),
      }),
      { mode: 0o600 },
    );
    const cli = (filename, code) => {
      const result = spawnSync(
        process.execPath,
        [
          path.join(
            ROOT,
            "core/control-plane/dist/preparation/fleet_install.js",
          ),
          "--package",
          filename,
          "--source-config",
          sourcePath,
          "--envelope",
          envelopePath,
          "--json",
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, code);
    };
    const linked = path.join(root, "linked-package.kvx");
    await fs.symlink(packagePath, linked);
    cli(linked, "FLEET_BOOTSTRAP_PATH");
    assertions["installer.path-escape-refused"] = true;
    cli(packagePath, "FLEET_INSTALL_INPUT_MISMATCH");
    assertions["installer.stale-input-refused"] = true;
    assert.equal(await fs.readFile(packagePath, "utf8"), packageText);
    await assert.rejects(fs.stat(environment), { code: "ENOENT" });
    assertions["installer.refusals-have-no-environment-effects"] = true;

    const layout = resolveFleetMounts({ manifest, sourceConfig, source });
    await fs.mkdir(environment);
    await materializeFleetMounts(layout, source, environment);
    const dependency = path.join(
      environment,
      "source/node_modules/installed/index.js",
    );
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.writeFile(dependency, "export const dependency = 1;\n");
    const workerSource = manifest.workers.source_template.replace(
      "{slot}",
      "0",
    );
    await assembleFleetWorkerSource(layout, {
      actualRoot: environment,
      workerSource,
    });
    await verifyFleetWorkerDependencies(layout, {
      actualRoot: environment,
      workerSource,
    });
    await fs.unlink(path.join(workerSource, "node_modules/installed/index.js"));
    await refused(
      "installer.missing-dependency-refused",
      "FLEET_INSTALL_DEPENDENCY_INTEGRITY",
      () =>
        verifyFleetWorkerDependencies(layout, {
          actualRoot: environment,
          workerSource,
        }),
    );
    assert.equal(
      await fs.readFile(dependency, "utf8"),
      "export const dependency = 1;\n",
    );

    const configuration = {
      kind: "config-ref",
      reference: "config-ref:runtime",
      target: path.join(environment, "runtime.json"),
      mode: "0444",
      required: true,
    };
    const configurationInput = {
      manifest: { "configuration.runtime": configuration },
      plan: {
        configuration_versions: [
          {
            name: "runtime",
            reference: configuration.reference,
            version: "1",
            digest: digest("pinned"),
          },
        ],
      },
      receiptConfigurations: [],
      sourcePaths: {},
      slots: [
        {
          slot: 0,
          worker_slot_id: "worker-0",
          home: path.join(environment, "workers/0/home"),
        },
      ],
    };
    await refused(
      "installer.missing-configuration-refused",
      "FLEET_INSTALL_CONFIGURATION_MISSING",
      () => verifyConfigurationSnapshot(configurationInput),
    );
    assertions["installer.missing-inputs-remain-missing"] = true;
    await assert.rejects(fs.stat(configuration.target), { code: "ENOENT" });
    await assert.rejects(
      fs.stat(path.join(workerSource, "node_modules/installed/index.js")),
      { code: "ENOENT" },
    );
    return {
      status: "PASS",
      assertions,
      signed_environment_installation: "UNRUN",
      provider_qualification: "UNRUN",
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await installerRefusals()));
