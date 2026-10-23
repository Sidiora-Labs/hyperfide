import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_SDK_VERSION } from "@hyperfide/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePluginSdkLayout,
  scaffoldPlugin,
} from "../src/plugin-scaffold.js";

describe("scaffoldPlugin SDK dependency", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hyperfide-scaffold-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("pins @hyperfide/plugin-sdk exactly and vendors no declarations", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-todo");
    await scaffoldPlugin({
      targetDir,
      packageName: "hyperfide-plugin-todo",
      hyperfideVersion: "0.9.0",
    });

    await expect(access(join(targetDir, "types"))).rejects.toThrow();

    const tsconfig = JSON.parse(
      await readFile(join(targetDir, "tsconfig.json"), "utf8"),
    );
    expect(tsconfig.compilerOptions.paths).toEqual({ "@/*": ["./*"] });
    expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
    expect(tsconfig.include).toEqual([
      "server.ts",
      "app.tsx",
      "components",
      "lib",
      "hooks",
    ]);

    const pkg = JSON.parse(
      await readFile(join(targetDir, "package.json"), "utf8"),
    );
    expect(pkg.devDependencies["@hyperfide/plugin-sdk"]).toBe(
      PLUGIN_SDK_VERSION,
    );
    expect(pkg.dependencies["@hyperfide/plugin-sdk"]).toBeUndefined();
    expect(pkg.engines).toEqual({
      hyperfide: ">=0.9",
      hyperfidePluginSdk: `>=${PLUGIN_SDK_VERSION}`,
    });
    expect(pkg.hyperfide).toMatchObject({
      name: "Todo",
      branding: { icon: "ListTodo" },
      server: "./server.ts",
      app: "./app.tsx",
    });
    expect(pkg.devDependencies["@types/react"]).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.devDependencies.zod).toBeUndefined();

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain(
      "node_modules/@hyperfide/plugin-sdk/bundled-types/hyperfide-plugin-sdk.d.ts",
    );
    expect(readme).toContain(
      "sync this plugin's SDK surface to the running HYPERFIDE",
    );
    expect(readme).not.toContain("rewrite types/");
    expect(readme).toContain("https://github.com/hyperfide/hyperfide");

    const components = JSON.parse(
      await readFile(join(targetDir, "components.json"), "utf8"),
    );
    expect(components.registries["@hyperfide"]).toBe(
      "https://raw.githubusercontent.com/hyperfide/hyperfide/desktop-v0.9.0/packages/plugin-registry/r/{name}.json",
    );
    expect(pkg.dependencies["@radix-ui/react-checkbox"]).toBeDefined();
    await access(join(targetDir, "components", "ui", "checkbox.tsx"));
  });

  it("writes a store overview that follows the marketplace content rules", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-todo");
    await scaffoldPlugin({
      targetDir,
      packageName: "hyperfide-plugin-todo",
      hyperfideVersion: "0.9.0",
    });

    const overview = await readFile(
      join(targetDir, "PLUGIN_OVERVIEW.md"),
      "utf8",
    );
    expect(overview).toContain("hyperfide-platform todo list");
    expect(overview).toMatch(/^[^#]/u);
    expect([...overview].length).toBeGreaterThan(700);
    expect([...overview].length).toBeLessThanOrEqual(4000);
    const prose = overview
      .replace(/```[\s\S]*?```/gu, "")
      .replace(/`[^`]*`/gu, "");
    expect(prose).not.toMatch(/<[A-Za-z!/?]|!\[/u);

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain("## Store listing");
    expect(readme).toContain("marketplace requires the file");
  });

  it("uses the canonical id in a scoped package scaffold", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-scoped");
    await scaffoldPlugin({
      targetDir,
      packageName: "@acme/hyperfide-plugin-scoped",
      hyperfideVersion: "0.9.0",
    });

    const pkg = JSON.parse(
      await readFile(join(targetDir, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@acme/hyperfide-plugin-scoped");
    expect(pkg.hyperfide.name).toBe("Scoped");

    const readme = await readFile(join(targetDir, "README.md"), "utf8");
    expect(readme).toContain("hyperfide-platform plugin reload scoped");
    expect(readme).toContain("hyperfide-platform plugin config scoped");

    const server = await readFile(join(targetDir, "server.ts"), "utf8");
    expect(server).toContain("hyperfide-platform plugin config scoped");
    expect(server).not.toContain("hyperfide-platform plugin config @acme/");
    expect(server).toContain('name: "scoped"');
    expect(server).toContain("hyperfide-platform scoped list");
    const app = await readFile(join(targetDir, "app.tsx"), "utf8");
    expect(app).toContain("hyperfide-platform scoped add");
    const skill = await readFile(
      join(targetDir, "skills", "example-todos", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("hyperfide-platform scoped list");
    expect(skill).not.toContain("@acme/");
  });
});

describe("resolvePluginSdkLayout", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "hyperfide-layout-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports the npm layout with its exact pin for a fresh scaffold", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-new-style");
    await scaffoldPlugin({
      targetDir,
      packageName: "hyperfide-plugin-new-style",
      hyperfideVersion: "0.9.0",
    });

    await expect(resolvePluginSdkLayout(targetDir)).resolves.toEqual({
      kind: "package",
      pin: PLUGIN_SDK_VERSION,
    });
  });

  it("reports the vendored layout for a legacy plugin", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-legacy");
    await scaffoldPlugin({
      targetDir,
      packageName: "hyperfide-plugin-legacy",
      hyperfideVersion: "0.9.0",
    });
    const pkgPath = join(targetDir, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    delete pkg.devDependencies["@hyperfide/plugin-sdk"];
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const tsconfigPath = join(targetDir, "tsconfig.json");
    const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8"));
    tsconfig.compilerOptions.paths = {
      "@hyperfide/plugin-sdk": ["./types/hyperfide-plugin-sdk.d.ts"],
    };
    await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

    await expect(resolvePluginSdkLayout(targetDir)).resolves.toEqual({
      kind: "vendored",
      pin: null,
    });
  });

  it("stays vendored while declarations exist but the path map is gone", async () => {
    const targetDir = join(workDir, "hyperfide-plugin-half-migrated");
    await scaffoldPlugin({
      targetDir,
      packageName: "hyperfide-plugin-half-migrated",
      hyperfideVersion: "0.9.0",
    });
    await mkdir(join(targetDir, "types"));
    await writeFile(
      join(targetDir, "types", "hyperfide-plugin-sdk.d.ts"),
      "legacy\n",
    );

    const layout = await resolvePluginSdkLayout(targetDir);
    expect(layout.kind).toBe("vendored");
    expect(layout.pin).toBe(PLUGIN_SDK_VERSION);
  });
});
