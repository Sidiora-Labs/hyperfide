import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bumpVersion } from "../../workspace/bump-version.mjs";
import { createRenameFailingFileSystem } from "./atomic-write-helpers.mjs";
import {
  deriveNightlyVersion,
  prepareNightlyVersion,
} from "../../workspace/prepare-nightly-version.mjs";

const scriptPath = fileURLToPath(
  new URL("../../workspace/bump-version.mjs", import.meta.url),
);
const testRoots = [];

function createPackageJson({ name, version }) {
  return `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`;
}

function createTestRepo({ hyperfideAppVersion, desktopVersion }) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hyperfide-bump-version-"));
  testRoots.push(repoRoot);

  mkdirSync(join(repoRoot, "apps", "launcher"), { recursive: true });
  mkdirSync(join(repoRoot, "apps", "desktop"), { recursive: true });
  writeFileSync(
    join(repoRoot, "apps", "launcher", "package.json"),
    createPackageJson({ name: "hyperfide-app", version: hyperfideAppVersion }),
  );
  writeFileSync(
    join(repoRoot, "apps", "desktop", "package.json"),
    createPackageJson({ name: "@hyperfide/desktop", version: desktopVersion }),
  );

  return repoRoot;
}

function readVersion(repoRoot, packagePath) {
  return JSON.parse(readFileSync(join(repoRoot, packagePath), "utf8")).version;
}

function readPackageContent(repoRoot, packagePath) {
  return readFileSync(join(repoRoot, packagePath), "utf8");
}

function runScript(repoRoot, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HYPERFIDE_BUMP_VERSION_REPO_ROOT: repoRoot,
    },
  });
}

afterEach(() => {
  for (const testRoot of testRoots.splice(0)) {
    rmSync(testRoot, { force: true, recursive: true });
  }
});

describe("bump-version", () => {
  it("exits non-zero for an invalid version argument", () => {
    const repoRoot = createTestRepo({
      hyperfideAppVersion: "0.0.6",
      desktopVersion: "0.0.6",
    });
    const result = runScript(repoRoot, ["not-semver"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid version: not-semver");
    expect(readVersion(repoRoot, "apps/launcher/package.json")).toBe("0.0.6");
    expect(readVersion(repoRoot, "apps/desktop/package.json")).toBe("0.0.6");
  });

  it("rejects a bump lower than the highest current target version", () => {
    const repoRoot = createTestRepo({
      hyperfideAppVersion: "0.0.6",
      desktopVersion: "0.0.9",
    });
    const originalHyperfideAppContent = readPackageContent(
      repoRoot,
      "apps/launcher/package.json",
    );
    const originalDesktopContent = readPackageContent(
      repoRoot,
      "apps/desktop/package.json",
    );
    const result = runScript(repoRoot, ["0.0.7"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "New version 0.0.7 must be greater than current max 0.0.9 across hyperfide-app=0.0.6 @hyperfide/desktop=0.0.9.",
    );
    expect(readPackageContent(repoRoot, "apps/launcher/package.json")).toBe(
      originalHyperfideAppContent,
    );
    expect(readPackageContent(repoRoot, "apps/desktop/package.json")).toBe(
      originalDesktopContent,
    );
  });

  it("updates both package versions for a valid version argument", () => {
    const repoRoot = createTestRepo({
      hyperfideAppVersion: "0.0.6",
      desktopVersion: "0.0.6",
    });
    const result = runScript(repoRoot, ["0.0.7"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Bumped: hyperfide-app + @hyperfide/desktop → 0.0.7");
    expect(readVersion(repoRoot, "apps/launcher/package.json")).toBe("0.0.7");
    expect(readVersion(repoRoot, "apps/desktop/package.json")).toBe("0.0.7");
  });

  it("restores the first package file when the second rename fails", async () => {
    const repoRoot = createTestRepo({
      hyperfideAppVersion: "0.0.6",
      desktopVersion: "0.0.6",
    });
    const originalHyperfideAppContent = readPackageContent(
      repoRoot,
      "apps/launcher/package.json",
    );
    const originalDesktopContent = readPackageContent(
      repoRoot,
      "apps/desktop/package.json",
    );
    const { fileSystem, getRenameCalls } = createRenameFailingFileSystem(2);

    await expect(
      bumpVersion({
        args: ["0.0.7"],
        fileSystem,
        log: () => {},
        repoRoot,
      }),
    ).rejects.toThrow("simulated rename failure");

    expect(getRenameCalls()).toBe(2);
    expect(readPackageContent(repoRoot, "apps/launcher/package.json")).toBe(
      originalHyperfideAppContent,
    );
    expect(readPackageContent(repoRoot, "apps/desktop/package.json")).toBe(
      originalDesktopContent,
    );
    expect(
      readdirSync(join(repoRoot, "apps", "launcher")),
    ).not.toContainEqual(expect.stringMatching(/^\.tmp-/u));
    expect(readdirSync(join(repoRoot, "apps", "desktop"))).not.toContainEqual(
      expect.stringMatching(/^\.tmp-/u),
    );
  });
});

describe("prepare-nightly-version", () => {
  it("derives a unique next-patch prerelease from the workflow run", () => {
    expect(deriveNightlyVersion("1.2.3", "123456", "2")).toBe(
      "1.2.4-nightly.123456.2",
    );
    expect(deriveNightlyVersion("1.2.3-beta.4", "123456", "2")).toBe(
      "1.2.4-nightly.123456.2",
    );
  });

  it("rejects workflow identifiers that are not semver-safe integers", () => {
    expect(() => deriveNightlyVersion("1.2.3", "run-1", "1")).toThrow(
      "GITHUB_RUN_ID must be a positive integer",
    );
    expect(() => deriveNightlyVersion("1.2.3", "1", "0")).toThrow(
      "GITHUB_RUN_ATTEMPT must be a positive integer",
    );
  });

  it("updates hyperfide-app and desktop to the same nightly version", async () => {
    const repoRoot = createTestRepo({
      hyperfideAppVersion: "1.2.3",
      desktopVersion: "1.2.3",
    });

    await expect(
      prepareNightlyVersion({
        repoRoot,
        runAttempt: "1",
        runId: "987654",
      }),
    ).resolves.toBe("1.2.4-nightly.987654.1");
    expect(readVersion(repoRoot, "apps/launcher/package.json")).toBe(
      "1.2.4-nightly.987654.1",
    );
    expect(readVersion(repoRoot, "apps/desktop/package.json")).toBe(
      "1.2.4-nightly.987654.1",
    );
  });
});
