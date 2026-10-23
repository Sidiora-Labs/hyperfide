import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly as scanPublicSdkOnly } from "../index.js";

let packageRoot: string;

function plant(files: Record<string, string>, manifest: object = {}): void {
  packageRoot = mkdtempSync(join(tmpdir(), "bb-public-sdk-only-"));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "planted", ...manifest }),
  );
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(packageRoot, file, ".."), { recursive: true });
    writeFileSync(join(packageRoot, file), source);
  }
}

afterEach(() => {
  rmSync(packageRoot, { recursive: true, force: true });
});

describe("experimental_scanPublicSdkOnly", () => {
  it("walks the package, skipping node_modules and dist, and accepts the published SDK surface", () => {
    plant({
      "server.ts": `import { z } from "zod";\nimport type { BbPluginApi } from "@hyperfide/plugin-sdk";\nimport { join } from "node:path";\nimport { helper } from "./src/helper.js";\n`,
      "src/helper.ts": `import "@hyperfide/plugin-sdk/provider-bridge";\nimport "@hyperfide/plugin-sdk/provider-bridge/acp";\nimport "@hyperfide/plugin-sdk/host";\nexport const helper = 1;\n`,
      "app.tsx": `import "@hyperfide/plugin-sdk/app";\n`,
      "server.test.ts": `import { it } from "vitest";\nimport "@hyperfide/plugin-sdk/testing";\nimport "@hyperfide/plugin-sdk/provider-bridge/testing";\n`,
      "node_modules/dep/index.js": `require("@hyperfide/domain");\n`,
      "dist/server.js": `import "@hyperfide/domain";\n`,
    });
    const scan = scanPublicSdkOnly(packageRoot);
    expect(scan.files.sort()).toEqual([
      "app.tsx",
      "server.test.ts",
      "server.ts",
      join("src", "helper.ts"),
    ]);
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });

  it("reports a private workspace import, a specifier outside the allowlist, and a testing subpath in plugin code", () => {
    plant({
      "server.ts": `import { events } from "@hyperfide/db";\nimport yaml from "yaml";\nimport "@hyperfide/plugin-sdk/testing";\n`,
      "server.test.ts": `import { createFakePluginHost } from "@hyperfide/plugin-sdk/testing";\nimport { describe } from "vitest";\n`,
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      { file: "server.ts", specifier: "@hyperfide/db", reason: "private-package" },
      { file: "server.ts", specifier: "yaml", reason: "outside-allowlist" },
      {
        file: "server.ts",
        specifier: "@hyperfide/plugin-sdk/testing",
        reason: "outside-allowlist",
      },
    ]);
  });

  it("admits the public packages a plugin names in `allow`, for plugin code and tests alike", () => {
    plant({
      "src/host.ts": `import { parse } from "smol-toml";\nimport yaml from "yaml";\n`,
      "src/host.test.ts": `import { parse } from "smol-toml";\n`,
    });
    expect(
      scanPublicSdkOnly(packageRoot, { allow: [/^yaml$/u, /^smol-toml$/u] })
        .violations,
    ).toEqual([]);
    expect(scanPublicSdkOnly(packageRoot).violations).toHaveLength(3);
  });

  it("reports a relative import that resolves outside the package root and admits one inside it", () => {
    plant({
      "src/bridge.ts": `import { threadEventSchema } from "../../outside.js";\nimport { helper } from "./inside.js";\nimport { shared } from "../sibling.js";\nimport { config } from "../../vitest.shared.js";\n`,
      "src/inside.ts": "export const helper = 1;\n",
      "sibling.ts": "export const shared = 1;\n",
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      {
        file: join("src", "bridge.ts"),
        specifier: "../../outside.js",
        reason: "outside-package",
      },
      {
        file: join("src", "bridge.ts"),
        specifier: "../../vitest.shared.js",
        reason: "outside-package",
      },
    ]);
    expect(
      scanPublicSdkOnly(packageRoot, {
        allow: [/^(?:\.\.\/)+vitest\.shared\.js$/u],
      }).violations.map((violation) => violation.specifier),
    ).toEqual(["../../outside.js"]);
  });

  it("reports an import() or require() whose specifier it cannot read", () => {
    plant({
      "server.ts": [
        `const name = "domain";`,
        `const spec = "@hyperfide/" + name;`,
        `const a = await import(spec);`,
        "const b = await import(`@hyperfide/${name}`);",
        `const c = require(spec);`,
        `const d = await import("./literal.js");`,
        "",
      ].join("\n"),
      "literal.ts": "export const literal = 1;\n",
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([
      { file: "server.ts", specifier: "spec", reason: "dynamic-specifier" },
      {
        file: "server.ts",
        specifier: "`@hyperfide/${name}`",
        reason: "dynamic-specifier",
      },
      { file: "server.ts", specifier: "spec", reason: "dynamic-specifier" },
    ]);
  });

  it("reads imports from syntax, not from method names, property calls, comments, strings, or JSX text", () => {
    plant({
      "server.ts": [
        "const f = { import(includeUncertain = false) { return includeUncertain; } };",
        "class Store { async require(path: string): Promise<void> {} }",
        "interface Importer { import(estimate: number): void; }",
        "f.import(estimate);",
        'f.import("@hyperfide/db");',
        "store?.require(path);",
        'const label = { import: "@hyperfide/db", export: 1 };',
        "const pattern = /from [\"']@hyperfide\\/db[\"']/u;",
        '// import("@hyperfide/db") or require(name)',
        '/* export * from "@hyperfide/db"; */',
        "const text = \"import('@hyperfide/db')\";",
        'const doc = `require(name) from "@hyperfide/db"`;',
        "const url = import.meta.url;",
        "",
      ].join("\n"),
      "server.test.ts": [
        'import { it } from "vitest";',
        'it("after a confirmed import", () => {});',
        'it("next test", () => {});',
        "",
      ].join("\n"),
      "app.tsx": [
        'import "@hyperfide/plugin-sdk/app";',
        "export function Panel<T,>(props: { items: T[] }) {",
        "  return (",
        '    <section title="don\'t import">',
        '      <p>Can\'t import (beta) from "@hyperfide/db" // or require(it)</p>',
        "      {props.items.length > 0 ? <List items={props.items} /> : null}",
        "      <>{/* import(name) */}</>",
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
    });
    expect(scanPublicSdkOnly(packageRoot).violations).toEqual([]);
  });

  it("still reports every real import form, including ones the old text scan read", () => {
    plant({
      "server.ts": [
        'import type { Event } from "@hyperfide/domain";',
        'import defaultThing, { named } from "yaml";',
        'import * as ns from "@hyperfide/sdk";',
        'import "side-effect";',
        'import legacy = require("@hyperfide/legacy");',
        'export { thing } from "@hyperfide/reexport";',
        'export * as all from "@hyperfide/star";',
        'export type { Shape } from "@hyperfide/types";',
        'type Lazy = typeof import("@hyperfide/lazy-type");',
        "const lazy = cond ? import(spec) : null;",
        'const nested = `${await import("@hyperfide/in-template")}`;',
        'const viaRequire = [require("@hyperfide/required")];',
        "",
      ].join("\n"),
      "app.tsx": [
        "export const View = () => (",
        '  <div onClick={() => import("@hyperfide/from-jsx")}>{require(name)}</div>',
        ");",
        "",
      ].join("\n"),
    });
    const violations = scanPublicSdkOnly(packageRoot).violations;
    const reported = (file: string) =>
      violations
        .filter((violation) => violation.file === file)
        .map(({ specifier, reason }) => `${reason} ${specifier}`);
    expect(reported("app.tsx")).toEqual([
      "private-package @hyperfide/from-jsx",
      "dynamic-specifier name",
    ]);
    expect(reported("server.ts")).toEqual([
      "private-package @hyperfide/domain",
      "outside-allowlist yaml",
      "private-package @hyperfide/sdk",
      "outside-allowlist side-effect",
      "private-package @hyperfide/legacy",
      "private-package @hyperfide/reexport",
      "private-package @hyperfide/star",
      "private-package @hyperfide/types",
      "private-package @hyperfide/lazy-type",
      "dynamic-specifier spec",
      "private-package @hyperfide/in-template",
      "private-package @hyperfide/required",
    ]);
  });

  it("lists @hyperfide/* names from both dependency blocks of package.json", () => {
    plant(
      { "server.ts": "" },
      {
        dependencies: { "@hyperfide/plugin-sdk": "^0.4.0", "@hyperfide/domain": "*" },
        devDependencies: { vitest: "^4", "@hyperfide/test-helpers": "*" },
      },
    );
    expect(scanPublicSdkOnly(packageRoot).privateDependencies).toEqual([
      "@hyperfide/domain",
      "@hyperfide/test-helpers",
    ]);
  });
});
