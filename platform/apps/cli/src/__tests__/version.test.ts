import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHyperfideAppVersion } from "../version.js";

describe("resolveHyperfideAppVersion", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hyperfide-cli-version-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("trims whitespace around HYPERFIDE_APP_VERSION", () => {
    expect(
      resolveHyperfideAppVersion({
        env: { HYPERFIDE_APP_VERSION: "  4.5.6  " },
        fromDir: tempRoot,
      }),
    ).toBe("4.5.6");
  });

  it("reads the hyperfide-app package.json adjacent to the binary", async () => {
    const packageRoot = join(tempRoot, "package-root");
    const binDir = join(packageRoot, "host-daemon", "dist");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "hyperfide-app", version: "0.0.7" }),
    );
    expect(
      resolveHyperfideAppVersion({
        env: {},
        fromDir: binDir,
      }),
    ).toBe("0.0.7");
  });

  it("ignores adjacent package.json files that are not hyperfide-app", async () => {
    const repoRoot = join(tempRoot, "repo");
    const cliDistDir = join(repoRoot, "apps", "cli", "dist");
    await mkdir(cliDistDir, { recursive: true });
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "hyperfide", version: "0.0.0", private: true }),
    );
    await writeFile(
      join(repoRoot, "apps", "cli", "package.json"),
      JSON.stringify({ name: "@hyperfide/cli", version: "0.0.1" }),
    );
    const hyperfideAppDir = join(repoRoot, "packages", "hyperfide-app");
    await mkdir(hyperfideAppDir, { recursive: true });
    await writeFile(
      join(hyperfideAppDir, "package.json"),
      JSON.stringify({ name: "hyperfide-app", version: "0.1.2" }),
    );
    expect(
      resolveHyperfideAppVersion({
        env: {},
        fromDir: cliDistDir,
      }),
    ).toBe("0.1.2");
  });

  it("falls back to the dev sentinel when no hyperfide-app package.json is found", () => {
    expect(
      resolveHyperfideAppVersion({
        env: {},
        fromDir: tempRoot,
      }),
    ).toBe("0.0.0-dev");
  });
});
