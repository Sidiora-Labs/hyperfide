import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { affectedPluginForks } from "../../workspace/lib/ci-plugin-forks.mjs";

it("checks both sides of plugin renames and falls back to full coverage for shared or unavailable changes", () => {
  const root = mkdtempSync(join(tmpdir(), "hyperfide-plugin-selection-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  const write = (path, value) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  git("init", "--quiet");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.com");
  git("config", "commit.gpgsign", "false");
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const plugins = ["plugins/alpha", "plugins/beta", "plugins/gamma"];
  write("plugins/alpha/file.ts", "export const value = 1;");
  write("plugins/beta/keep.ts", "export const keep = true;");
  const base = commit();
  expect(affectedPluginForks(root, base, plugins)).toEqual([]);
  git("mv", "plugins/alpha/file.ts", "plugins/beta/renamed.ts");
  commit();
  expect(affectedPluginForks(root, base, plugins)).toEqual([
    "plugins/alpha",
    "plugins/beta",
  ]);
  write("sdk/plugins/source.ts", "export const shared = true;");
  commit();
  expect(affectedPluginForks(root, base, plugins)).toEqual(plugins);
  expect(affectedPluginForks(root, "0".repeat(40), plugins)).toEqual(plugins);
  expect(affectedPluginForks(root, undefined, plugins)).toEqual(plugins);
}, 30_000);

it("partitions fork checks without losing plugins and rejects invalid shards", () => {
  const script = fileURLToPath(
    new URL("../../workspace/check-plugin-forks.mjs", import.meta.url),
  );
  const list = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [script, "--list", ...args], {
        encoding: "utf8",
      }),
    );
  const plugins = list();
  for (const count of [1, 3, plugins.length + 1]) {
    const shards = Array.from({ length: count }, (_, index) =>
      list(`--shard=${index + 1}/${count}`),
    );
    const combined = shards.flat();
    expect(combined.toSorted()).toEqual(plugins.toSorted());
    expect(new Set(combined).size).toBe(combined.length);
    expect(
      Math.max(...shards.map((shard) => shard.length)) -
        Math.min(...shards.map((shard) => shard.length)),
    ).toBeLessThanOrEqual(1);
  }
  const selected = plugins.slice(0, 2);
  expect(list(...selected, "--shard=1/3")).toEqual([selected[0]]);
  expect(list(...selected, "--shard=2/3")).toEqual([selected[1]]);
  expect(list(...selected, "--shard=3/3")).toEqual([]);
  for (const shard of [
    "0/3",
    "4/3",
    "1/0",
    "1.5/3",
    "1/3junk",
    "1/9007199254740992",
  ]) {
    const result = spawnSync(
      process.execPath,
      [script, "--list", `--shard=${shard}`],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--shard requires an index/count");
  }
  const invalidPlugin = spawnSync(
    process.execPath,
    [script, "--list", "plugins/not-forkable", "--shard=2/3"],
    { encoding: "utf8" },
  );
  expect(invalidPlugin.status).not.toBe(0);
  expect(invalidPlugin.stderr).toContain(
    "is not listed in scripts/forkable-plugins.json",
  );
}, 30_000);
