import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSpecCli, registerSpecCli } from "./index.mjs";

const repo = resolve(import.meta.dirname, "../../../..");
test("plugin registration exposes all four commands", () => {
  let registration: import("./index.mjs").SpecCliRegistration | undefined;
  registerSpecCli({ cli: { register(value) { registration = value; } } });
  assert.equal(registration!.name, "spec");
  assert.deepEqual(registration!.commands.map((item) => item.name), ["next", "start", "implemented", "status"]);
});

test("process adapter preserves arbitrary exit codes and JSON bytes", async () => {
  const cwd = mkdtempSync(resolve(tmpdir(), "hyperfide-spec-cli-"));
  try {
    const binary = resolve(cwd, "hyperfide");
    writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("failure\\n"); process.exit(23);\n', { mode: 0o755 });
    const result = await createSpecCli({ binary }).run(["status", "-f", "demo", "--json"], { cwd });
    assert.equal(result.exitCode, 23);
    assert.equal(result.stdout, '["spec","status","-f","demo","--json"]');
    assert.equal(result.stderr, "failure\nhyperfide spec: feature demo, task (board)\n");
    const missing = await createSpecCli({ binary: resolve(cwd, "absent") }).run(["start", "1.2", "-f", "demo"], { cwd });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr!, /feature demo, task 1\.2/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("all commands match the binary against independent fixture repositories", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "hyperfide-spec-parity-"));
  const binary = process.env.HYPERFIDE_BIN ?? resolve(repo, "cg");
  const direct = resolve(root, "direct");
  const platform = resolve(root, "platform");
  try {
    for (const cwd of [direct, platform]) {
      cpSync(resolve(repo, "tests/fixtures/specrepo"), cwd, { recursive: true });
      const mode = spawnSync(binary, ["spec", "mode", "prod"], { cwd, encoding: "utf8" });
      assert.equal(mode.status, 0, mode.stderr);
    }
    const cli = createSpecCli({ binary });
    for (const args of [
      ["status", "--json"], ["next"], ["start", "2.1"],
      ["start", "1.2"], ["implemented", "1.2"], ["status"],
      ["start", "missing"], ["status", "--json", "-f", "missing"],
    ]) {
      const argv = [...args, "-f", args.includes("missing") && args[0] === "status" ? "missing" : "demo"];
      const expected = spawnSync(binary, ["spec", ...argv], { cwd: direct, encoding: "utf8" });
      const actual = await cli.run(argv, { cwd: platform });
      assert.equal(actual.exitCode, expected.status, argv.join(" "));
      assert.equal(actual.stdout, expected.stdout.replaceAll(direct, platform));
      assert.ok(actual.stderr!.startsWith(expected.stderr.replaceAll(direct, platform)));
      if (actual.exitCode === 0) assert.match(actual.stderr!, /Board: .*\/plugins\/hyperfide-spec\?feature=demo/);
      else assert.match(actual.stderr!, /feature .*task /);
      if (argv[0] === "status" && argv.includes("--json") && actual.exitCode === 0) JSON.parse(actual.stdout!);
    }
    const rooted = await cli.run(["status", "--json", "-f", "demo", "--root", platform], { cwd: root });
    assert.equal(rooted.exitCode, 0, rooted.stderr);
    assert.equal(JSON.parse(rooted.stdout!).feature, "demo");
    const inferred = await cli.run(["start", "missing"], { cwd: platform });
    assert.equal(inferred.exitCode, 1);
    assert.match(inferred.stderr!, /feature demo, task missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
