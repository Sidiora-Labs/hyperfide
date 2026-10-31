import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HYPERFIDE_CLI_REEXEC_ENV,
  maybeReexecViaHyperfideCli,
  resolveHyperfideCliLaunch,
} from "../hyperfide-cli-reexec.js";

describe("maybeReexecViaHyperfideCli", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "hyperfide-cli-reexec-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeExecutable(name: string): Promise<string> {
    const path = join(tempRoot, name);
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  }

  it("no-ops when HYPERFIDE_CLI is unset", () => {
    const reexec = vi.fn();
    maybeReexecViaHyperfideCli({
      env: {},
      currentExecutablePath: "/tmp/current-hyperfide",
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when HYPERFIDE_CLI equals the current executable", async () => {
    const path = await writeExecutable("hyperfide");
    const reexec = vi.fn();
    maybeReexecViaHyperfideCli({
      env: { HYPERFIDE_CLI: path },
      currentExecutablePath: path,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("no-ops when already in a re-exec hop", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaHyperfideCli({
      env: { HYPERFIDE_CLI: target, [HYPERFIDE_CLI_REEXEC_ENV]: "1" },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });

  it("re-execs to HYPERFIDE_CLI when it differs from the current entry", async () => {
    const current = await writeExecutable("current");
    const target = await writeExecutable("target");
    const reexec = vi.fn();
    maybeReexecViaHyperfideCli({
      env: {
        HYPERFIDE_CLI: target,
        HYPERFIDE_SERVER_URL: "http://127.0.0.1:1",
      },
      currentExecutablePath: current,
      argv: ["status", "--json"],
      reexec,
    });
    expect(reexec).toHaveBeenCalledOnce();
    expect(reexec.mock.calls[0]?.[0]).toEqual({
      target: realpathSync(target),
      argv: ["status", "--json"],
      env: expect.objectContaining({
        HYPERFIDE_CLI: target,
        HYPERFIDE_SERVER_URL: "http://127.0.0.1:1",
        [HYPERFIDE_CLI_REEXEC_ENV]: "1",
      }),
    });
  });

  it("no-ops when HYPERFIDE_CLI path is missing", async () => {
    const current = await writeExecutable("current");
    const reexec = vi.fn();
    maybeReexecViaHyperfideCli({
      env: { HYPERFIDE_CLI: join(tempRoot, "does-not-exist") },
      currentExecutablePath: current,
      reexec,
    });
    expect(reexec).not.toHaveBeenCalled();
  });
});

describe("resolveHyperfideCliLaunch", () => {
  it("runs an extensionless HYPERFIDE_CLI script through Node on Windows", () => {
    expect(
      resolveHyperfideCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\hyperfide\\host-daemon\\dist\\hyperfide",
      }),
    ).toEqual({
      command: "C:\\node\\node.exe",
      args: ["C:\\hyperfide\\host-daemon\\dist\\hyperfide", "status"],
    });
  });

  it("executes HYPERFIDE_CLI directly when the platform can run it", () => {
    expect(
      resolveHyperfideCliLaunch({
        argv: ["status"],
        nodePath: "C:\\node\\node.exe",
        platform: "win32",
        target: "C:\\tools\\hyperfide.exe",
      }),
    ).toEqual({ command: "C:\\tools\\hyperfide.exe", args: ["status"] });
    expect(
      resolveHyperfideCliLaunch({
        argv: ["status"],
        nodePath: "/usr/bin/node",
        platform: "darwin",
        target: "/opt/hyperfide/host-daemon/dist/hyperfide",
      }),
    ).toEqual({ command: "/opt/hyperfide/host-daemon/dist/hyperfide", args: ["status"] });
  });
});
