import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDevInstanceConfig } from "@hyperfide/config/runtime";
import {
  createDesktopPackageCommand,
  createDesktopRunCommand,
  resolveDesktopLaunchMode,
  resolveDesktopPackageTask,
  resolveDesktopUserDataDir,
  toDesktopLaunchProcessEnv,
} from "../src/commands/run-desktop.js";

const config = resolveDevInstanceConfig({
  homeDir: "/Users/tester",
  repoRoot: "/Users/tester/checkouts/bb",
});

describe("desktop launch mode", () => {
  it("defaults to the installed data directory and rejects unknown arguments", () => {
    expect(resolveDesktopLaunchMode([])).toBe("prod");
    expect(resolveDesktopLaunchMode(["--worktree"])).toBe("worktree");
    expect(() => resolveDesktopLaunchMode(["--worktre"])).toThrow(
      /Unknown arguments: --worktre/u,
    );
    expect(() => resolveDesktopLaunchMode(["--worktree", "--extra"])).toThrow(
      /Unknown arguments/u,
    );
  });
});

describe("desktop packaging task", () => {
  it("selects the platform packaging task and refuses unsupported platforms", () => {
    expect(resolveDesktopPackageTask("darwin")).toBe("package");
    expect(resolveDesktopPackageTask("linux")).toBe("package:linux");
    expect(resolveDesktopPackageTask("win32")).toBe("package:win");
    expect(() => resolveDesktopPackageTask("freebsd")).toThrow(
      /supported on macOS, Linux, and Windows/u,
    );
    expect(createDesktopPackageCommand("darwin").args).toEqual(
      expect.arrayContaining(["run", "package", "--filter=@hyperfide/desktop"]),
    );
  });

  it("runs the packaged app from the desktop package directory", () => {
    const command = createDesktopRunCommand();
    expect(command.cwd.endsWith(`${sep}${join("apps", "desktop")}`)).toBe(true);
    expect(
      command.args[0]?.endsWith(
        `${sep}${join("scripts", "run-packaged-app.mjs")}`,
      ),
    ).toBe(true);
  });
});

describe("desktop launch environment", () => {
  it("isolates the worktree launch onto this checkout's data directory and ports", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: {
        HYPERFIDE_DATA_DIR: "/Users/tester/.hyperfide",
        HYPERFIDE_DEV_APP_PORT: "5173",
        HYPERFIDE_TELEMETRY: "true",
        NODE_ENV: "development",
        OPENAI_API_KEY: "test-key",
      },
      config,
      mode: "worktree",
    });

    expect(env).toMatchObject({
      HYPERFIDE_DATA_DIR: config.dataDir,
      HYPERFIDE_DESKTOP_DEV_ICON: "1",
      HYPERFIDE_DESKTOP_OPEN_DEVTOOLS: "0",
      HYPERFIDE_DESKTOP_USER_DATA_DIR: join(config.dataDir, "desktop"),
      HYPERFIDE_HOST_DAEMON_PORT: String(config.ports.hostDaemonPort),
      HYPERFIDE_SERVER_PORT: String(config.ports.serverPort),
      HYPERFIDE_SKIP_ONBOARDING: "1",
      HYPERFIDE_TELEMETRY: "false",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
    expect(env.HYPERFIDE_DATA_DIR).not.toBe("/Users/tester/.hyperfide");
    expect(env.HYPERFIDE_SERVER_PORT).not.toBe("38886");
    expect(env.HYPERFIDE_DEV_APP_PORT).toBeUndefined();
  });

  it("preserves an explicit Electron user data directory", () => {
    const userDataDir = "/tmp/bb-desktop-profile";
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { HYPERFIDE_DESKTOP_USER_DATA_DIR: ` ${userDataDir} ` },
      config,
      mode: "worktree",
    });

    expect(env.HYPERFIDE_DESKTOP_USER_DATA_DIR).toBe(resolve(userDataDir));
    expect(
      resolveDesktopUserDataDir(
        { HYPERFIDE_DESKTOP_USER_DATA_DIR: "relative-profile" },
        config,
      ),
    ).toBe(join(process.cwd(), "relative-profile"));
  });

  it("lets an explicit onboarding choice survive the worktree default", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { HYPERFIDE_SKIP_ONBOARDING: "0" },
      config,
      mode: "worktree",
    });

    expect(env.HYPERFIDE_SKIP_ONBOARDING).toBe("0");
  });

  it("lets an explicit devtools choice survive the worktree default", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { HYPERFIDE_DESKTOP_OPEN_DEVTOOLS: "1" },
      config,
      mode: "worktree",
    });

    expect(env.HYPERFIDE_DESKTOP_OPEN_DEVTOOLS).toBe("1");
  });

  it("leaves the installed data directory and ports alone without --worktree", () => {
    const env = toDesktopLaunchProcessEnv({
      baseEnv: { NODE_ENV: "development", OPENAI_API_KEY: "test-key" },
      config,
      mode: "prod",
    });

    expect(env.HYPERFIDE_DATA_DIR).toBeUndefined();
    expect(env.HYPERFIDE_SERVER_PORT).toBeUndefined();
    expect(env.HYPERFIDE_HOST_DAEMON_PORT).toBeUndefined();
    expect(env.HYPERFIDE_DESKTOP_USER_DATA_DIR).toBeUndefined();
    expect(env.HYPERFIDE_SKIP_ONBOARDING).toBeUndefined();
    expect(env).toMatchObject({
      HYPERFIDE_DESKTOP_OPEN_DEVTOOLS: "0",
      NODE_ENV: "production",
      OPENAI_API_KEY: "test-key",
    });
  });
});
