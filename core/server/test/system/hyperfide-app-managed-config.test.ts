import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHyperfideAppConfigPath } from "@hyperfide/config/hyperfide-app-managed-config";
import { defaultFeatureFlags } from "@hyperfide/domain";
import { describe, expect, it } from "vitest";
import {
  applyHyperfideAppManagedConfig,
  createHyperfideAppManagedConfigReloader,
} from "../../src/services/system/hyperfide-app-managed-config.js";
import { NotificationHub } from "../../src/ws/hub.js";
import type { ServerLogger, ServerRuntimeConfig } from "../../src/types.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

interface CountingLogger {
  logger: ServerLogger;
  warnings(): Array<{ fields: Record<string, unknown>; message: string }>;
  warningCount(): number;
}

function createTestLogger(): ServerLogger {
  return {
    debug(): void {},
    error(): void {},
    info(): void {},
    warn(): void {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCountingLogger(): CountingLogger {
  const warnings: Array<{ fields: Record<string, unknown>; message: string }> =
    [];
  return {
    logger: {
      debug(): void {},
      error(): void {},
      info(): void {},
      warn(...args: unknown[]): void {
        const fields = isRecord(args[0]) ? args[0] : {};
        const message =
          typeof args[1] === "string" ? args[1] : String(args[0] ?? "");
        warnings.push({ fields, message });
      },
    },
    warnings(): Array<{ fields: Record<string, unknown>; message: string }> {
      return warnings;
    },
    warningCount(): number {
      return warnings.length;
    },
  };
}

function createRuntimeConfig(): ServerRuntimeConfig {
  return {
    appUrl: "https://ambient-app.example.test",
    appVersion: "0.0.0-test",
    builtinSkillsRootPath: "/tmp/hyperfide-test/builtin-skills",
    customModels: [],
    dataDir: "/tmp/hyperfide-test",
    marketplaceUrl: "https://marketplace.invalid/marketplace.json",
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: 38887,
    inheritedSkillsRootPaths: [],
    isDevelopment: false,
    performanceDiagnosticsAvailable: false,
    serverPort: 38886,
    sharedSkillRoots: { user: [], project: [] },
  };
}

describe("hyperfide-app managed config", () => {
  it("applies managed config over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {
        config: {
          HYPERFIDE_APP_URL: "https://stored-app.example.test",
        },
      },
      targetConfig,
    });

    expect(targetConfig).toMatchObject({
      appUrl: "https://stored-app.example.test",
    });
  });

  it("restores base values when managed config keys are removed", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {
        config: {
          HYPERFIDE_APP_URL: "https://stored-app.example.test",
        },
      },
      targetConfig,
    });
    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {},
      targetConfig,
    });

    expect(targetConfig.appUrl).toBe("https://ambient-app.example.test");
  });

  it("applies custom models over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {
        customModels: [
          {
            providerId: "claude-code",
            model: "claude-example-preview[1m]",
            displayName: "Example Preview (1M)",
          },
        ],
      },
      targetConfig,
    });

    expect(targetConfig.customModels).toEqual([
      {
        providerId: "claude-code",
        model: "claude-example-preview[1m]",
        displayName: "Example Preview (1M)",
      },
    ]);
  });

  it("applies shared skill roots over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {
        sharedSkillRoots: {
          user: [".agents/skills"],
          project: [".agents/skills"],
        },
      },
      targetConfig,
    });

    expect(targetConfig.sharedSkillRoots).toEqual({
      user: [".agents/skills"],
      project: [".agents/skills"],
    });
  });

  it("restores base custom models when the key is removed", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {
        customModels: [
          { providerId: "claude-code", model: "claude-example-preview" },
        ],
      },
      targetConfig,
    });
    applyHyperfideAppManagedConfig({
      baseConfig,
      managedConfig: {},
      targetConfig,
    });

    expect(targetConfig.customModels).toEqual([]);
  });

  it("ignores removed AI service keys with a warning on reload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-managed-config-"));
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const logger = createCountingLogger();
    const reloader = await createHyperfideAppManagedConfigReloader({
      config,
      hub: new NotificationHub(),
      logger: logger.logger,
    });

    try {
      writeFileSync(
        formatHyperfideAppConfigPath(dataDir),
        `${JSON.stringify({
          config: {
            HYPERFIDE_APP_URL: "https://live-app.example.test",
            HYPERFIDE_INFERENCE: "codex/gpt-5.6-luna",
          },
        })}\n`,
        "utf8",
      );

      await reloader.reload({ notify: false });
      expect(config.appUrl).toBe("https://live-app.example.test");
      expect(logger.warnings()).toEqual([
        expect.objectContaining({
          fields: { keys: ["HYPERFIDE_INFERENCE"] },
          message: expect.stringContaining("Settings → AI services"),
        }),
      ]);
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("reloads a config that still carries the removed customAcpAgents array", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-managed-config-"));
    const socket = createMockHubSocket();
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const hub = new NotificationHub();
    const logger = createCountingLogger();
    hub.subscribe(socket, { kind: "system" });

    const reloader = await createHyperfideAppManagedConfigReloader({
      config,
      hub,
      logger: logger.logger,
    });

    try {
      writeFileSync(
        formatHyperfideAppConfigPath(dataDir),
        `${JSON.stringify({
          customAcpAgents: [
            {
              id: "valid-agent",
              displayName: "Valid Agent",
              command: "valid-agent",
            },
            {
              id: "bad agent",
              displayName: "Bad Agent",
              command: "bad-agent",
            },
          ],
          customModels: [{ providerId: "codex", model: "gpt-5.5-codex" }],
        })}\n`,
        "utf8",
      );

      await reloader.reload({ notify: true });

      expect(config.customModels).toEqual([
        { providerId: "codex", model: "gpt-5.5-codex" },
      ]);
      expect(logger.warnings()).toEqual([
        {
          fields: { key: "customAcpAgents" },
          message: expect.stringContaining("customAcpAgents"),
        },
      ]);
      expect(
        socket.messages.some((message) => message.includes("config-changed")),
      ).toBe(true);
    } finally {
      hub.unregisterClient(socket);
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("ignores corrupt managed config during initial startup reload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-managed-config-"));
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const logger = createCountingLogger();

    try {
      writeFileSync(formatHyperfideAppConfigPath(dataDir), "{", "utf8");

      await expect(
        createHyperfideAppManagedConfigReloader({
          config,
          hub: new NotificationHub(),
          logger: logger.logger,
        }),
      ).resolves.toBeDefined();

      expect(config.appUrl).toBe("https://ambient-app.example.test");
      expect(logger.warningCount()).toBe(1);
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("throws on invalid managed config during explicit reload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hyperfide-managed-config-"));
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const reloader = await createHyperfideAppManagedConfigReloader({
      config,
      hub: new NotificationHub(),
      logger: createTestLogger(),
    });

    try {
      writeFileSync(
        formatHyperfideAppConfigPath(dataDir),
        `${JSON.stringify({ config: { HYPERFIDE_APP_URL: "not-a-url" } })}\n`,
        "utf8",
      );

      await expect(reloader.reload({ notify: true })).rejects.toThrow(
        /HYPERFIDE_APP_URL/u,
      );
      expect(config.appUrl).toBe("https://ambient-app.example.test");
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
