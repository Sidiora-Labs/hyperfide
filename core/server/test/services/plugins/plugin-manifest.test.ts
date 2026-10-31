import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";

describe("plugin manifest", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "hyperfide-plugin-manifest-"));
    await writeFile(join(rootDir, "server.ts"), "export default () => {};\n");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const validHyperfide = {
    name: "Contract fixture",
    description: "Plugin manifest contract fixture.",
    branding: { icon: "Zap" },
    server: "./server.ts",
  };

  async function writeManifest(
    hyperfidePluginSdk?: string,
    hyperfide: Record<string, unknown> = validHyperfide,
  ): Promise<void> {
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "hyperfide-plugin-contract",
        version: "2.3.4",
        ...(hyperfidePluginSdk === undefined ? {} : { engines: { hyperfidePluginSdk } }),
        hyperfide,
      }),
    );
  }

  it("accepts a valid engines.hyperfidePluginSdk range", async () => {
    await writeManifest("^0.2.0 || >=2.0.0");
    expect((await readPluginManifest(rootDir)).hyperfidePluginSdkRange).toBe(
      "^0.2.0 || >=2.0.0",
    );
  });

  it("rejects an invalid engines.hyperfidePluginSdk range clearly", async () => {
    await writeManifest("definitely not semver");
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /engines\.hyperfidePluginSdk.*valid semver range/,
    );
  });

  it("accepts an absent range as a legacy manifest", async () => {
    await writeManifest();
    expect(
      (await readPluginManifest(rootDir)).hyperfidePluginSdkRange,
    ).toBeUndefined();
  });

  it("accepts one optional host entry and resolves it inside the plugin", async () => {
    await writeFile(join(rootDir, "host.ts"), "export default {};\n");
    await writeManifest(undefined, { ...validHyperfide, host: "./host.ts" });

    expect((await readPluginManifest(rootDir)).hostEntry).toBe(
      join(rootDir, "host.ts"),
    );
  });

  it("rejects a missing or escaping host entry", async () => {
    await writeManifest(undefined, { ...validHyperfide, host: "./missing.ts" });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /hyperfide\.host.*missing file/u,
    );

    await writeManifest(undefined, { ...validHyperfide, host: "../host.ts" });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /hyperfide\.host.*escapes the plugin directory/u,
    );
  });

  it.each(["name", "description"] as const)(
    "requires a non-empty hyperfide.%s string",
    async (field: "name" | "description") => {
      const { [field]: _omitted, ...withoutField } = validHyperfide;
      await writeManifest(undefined, withoutField);
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`hyperfide\\.${field}`),
      );

      await writeManifest(undefined, { ...validHyperfide, [field]: "   " });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`hyperfide\\.${field}`),
      );

      await writeManifest(undefined, { ...validHyperfide, [field]: null });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        new RegExp(`hyperfide\\.${field}`),
      );
    },
  );

  it("requires branding with an icon or light logo", async () => {
    for (const branding of [undefined, null, {}, { icon: "   " }]) {
      await writeManifest(undefined, { ...validHyperfide, branding });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(/hyperfide\.branding/);
    }
  });

  it("resolves a path-shaped branding.icon as a plugin-owned compact SVG", async () => {
    await mkdir(join(rootDir, "assets"));
    await writeFile(join(rootDir, "assets", "icon.svg"), "<svg/>");
    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { icon: "./assets/icon.svg" },
    });

    const manifest = await readPluginManifest(rootDir);
    expect(manifest.branding.icon).toBe("./assets/icon.svg");
    expect(manifest.branding.compactIconPath).toBe(
      join(rootDir, "assets", "icon.svg"),
    );
  });

  it("keeps a named branding.icon as a host icon hint", async () => {
    await writeManifest();
    const manifest = await readPluginManifest(rootDir);
    expect(manifest.branding.icon).toBe("Zap");
    expect(manifest.branding.compactIconPath).toBeUndefined();
  });

  it("requires path-shaped branding.icon to be a readable SVG", async () => {
    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { icon: "./missing.svg" },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(/missing file/);

    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { icon: "./icon.png" },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /branding\.icon.*\.svg/,
    );
  });

  it.each([
    ["non-SVG XML", "<html/>", /<svg> root element/],
    ["malformed XML", "<svg><path></svg>", /not valid SVG XML/],
    [
      "entity declarations",
      '<!DOCTYPE svg [<!ENTITY mark "x">]><svg>&mark;</svg>',
      /must not contain a doctype declaration/,
    ],
    ["a foreign namespace", '<x:svg xmlns:x="urn:not-svg"/>', /<svg> root/],
  ])(
    "rejects a path-shaped branding.icon with %s",
    async (_case, icon, error) => {
      await writeFile(join(rootDir, "icon.svg"), icon);
      await writeManifest(undefined, {
        ...validHyperfide,
        branding: { icon: "./icon.svg" },
      });

      await expect(readPluginManifest(rootDir)).rejects.toThrow(error);
    },
  );

  it("rejects a dark logo without a light logo", async () => {
    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { logo: { dark: "./dark.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /hyperfide\.branding\.logo\.light/,
    );
  });

  it("rejects null and empty branding asset paths", async () => {
    for (const light of [null, "   "]) {
      await writeManifest(undefined, {
        ...validHyperfide,
        branding: { logo: { light } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /hyperfide\.branding\.logo\.light/,
      );
    }
    for (const dark of [null, "   "]) {
      await writeManifest(undefined, {
        ...validHyperfide,
        branding: { logo: { light: "./light.svg", dark } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /hyperfide\.branding\.logo\.dark/,
      );
    }
  });

  it.each([
    ["displayName", "Legacy name"],
    ["icon", "Zap"],
    ["logo", "./logo.svg"],
    ["logoDark", "./logo-dark.svg"],
  ])(
    "rejects the legacy hyperfide.%s field instead of ignoring it",
    async (field, value) => {
      await writeManifest(undefined, { ...validHyperfide, [field]: value });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /unrecognized key/i,
      );
    },
  );

  it("requires declared logo assets to be supported files", async () => {
    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { logo: { light: "./missing.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(/missing file/);

    await mkdir(join(rootDir, "directory.svg"));
    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { logo: { light: "./directory.svg" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /point at a file/,
    );

    await writeManifest(undefined, {
      ...validHyperfide,
      branding: { logo: { light: "./logo.gif" } },
    });
    await expect(readPluginManifest(rootDir)).rejects.toThrow(
      /\.svg, \.png, or \.webp/,
    );
  });

  it("rejects a branding asset symlink that escapes the plugin directory", async () => {
    const outsideDir = await mkdtemp(
      join(tmpdir(), "hyperfide-plugin-branding-outside-"),
    );
    try {
      const outsideAsset = join(outsideDir, "outside.svg");
      await writeFile(outsideAsset, "<svg/>");
      await symlink(outsideAsset, join(rootDir, "linked.svg"));
      await writeManifest(undefined, {
        ...validHyperfide,
        branding: { logo: { light: "./linked.svg" } },
      });
      await expect(readPluginManifest(rootDir)).rejects.toThrow(
        /escapes the plugin directory through a symlink/,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
