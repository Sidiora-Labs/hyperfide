// Generates the self-contained `.d.ts` bundles that `hyperfide-platform plugin new` ships into
// a scaffolded plugin's `types/` directory, so authors get real HyperfidePluginApi /
// @hyperfide/plugin-sdk/app types WITHOUT the (unpublished) @hyperfide/* workspace packages
// on disk.
//
// rollup-plugin-dts flattens @hyperfide/plugin-sdk's own contracts plus every @hyperfide/*
// type it references (HyperfideSdk, PromptInput, ThreadResponse, …) into the root
// file. Testing subpaths reuse that already-portable root declaration through
// the package's own public name instead of flattening the same contracts a
// second time. Genuine npm packages remain external imports and resolve from
// the consumer's own dependencies.
//
// The output, bundled-types/*.d.ts, is NOT committed. It is the package's
// published `types` surface and a build output of the turbo task
// `@hyperfide/plugin-sdk#build:types`; @hyperfide/templates reads it at scaffold-embed
// time by file path (no package edge, to avoid a dependency cycle), and the
// in-repo plugins typecheck against it. Unchanged files are not rewritten so
// mtimes stay stable for watchers.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import {
  declarationId,
  sharedDeclarationEmit,
} from "./shared-declaration-emit.mjs";

import { normalizeBundledDts } from "./normalize-bundled-dts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const workspacePackages = new Map();
for (const category of ["apps", "core", "sdk", "contracts", "lib", "tools"]) {
  const categoryRoot = path.join(repoRoot, category);
  for (const entry of readdirSync(categoryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(categoryRoot, entry.name);
    const manifest = path.join(directory, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name !== "string" || !name.startsWith("@hyperfide/")) continue;
    if (workspacePackages.has(name)) throw new Error(`Duplicate workspace package ${name}`);
    workspacePackages.set(name, directory);
  }
}
// Server-contract modules whose real declarations are not portable into a
// flattened .d.ts, each redirected to a loose stub (the stub headers say why).
const STUBBED_MODULES = new Map([
  [
    path.join(repoRoot, "contracts/server/src/public-api.ts"),
    path.join(here, "public-api-stub.d.ts"),
  ],
  [
    path.join(repoRoot, "contracts/server/src/api-client.ts"),
    path.join(here, "api-client-stub.d.ts"),
  ],
]);
const outDir = path.join(pkgRoot, "bundled-types");
const { exports: packageExports } = JSON.parse(
  readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
);
const outputs = Object.fromEntries(
  Object.values(packageExports).map((entry) => [
    path.basename(entry.types),
    path.join(pkgRoot, entry.source),
  ]),
);

// Real npm packages the bundle imports from — kept external so they resolve
// from the scaffold's devDependencies rather than being inlined.
const EXTERNAL = [
  /^@tanstack\/react-query($|\/)/,
  /^node:/,
  /^@testing-library\/react($|\/)/,
  /^better-sqlite3/,
  /^hono($|\/)/,
  /^react($|\/|-)/,
  /^react-dom($|\/)/,
  /^zod($|\/)/,
];

/** Resolve any `@hyperfide/<pkg>[/<sub>]` to its `source` export target on disk. */
function resolveHyperfideSource(id) {
  const match = /^@hyperfide\/([^/]+)(\/.*)?$/.exec(id);
  if (!match) return null;
  const pkgDir = workspacePackages.get(`@hyperfide/${match[1]}`);
  if (!pkgDir) return null;
  const manifestPath = path.join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  const { exports } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const key = match[2] ? "." + match[2] : ".";
  const entry = exports?.[key];
  const source =
    typeof entry === "string"
      ? entry
      : (entry?.source ?? entry?.types ?? entry?.default);
  return source ? path.join(pkgDir, source) : null;
}

const inlineWorkspace = {
  name: "inline-hyperfide-workspace",
  resolveId(id, importer) {
    // Redirect server-contract's non-portable modules to their loose stubs,
    // whether imported by bare specifier or by a sibling's relative path.
    if (importer) {
      const asTs = path.resolve(
        path.dirname(importer),
        id.replace(/\.js$/, ".ts"),
      );
      const stub = STUBBED_MODULES.get(asTs);
      if (stub) return stub;
    }
    const stub = STUBBED_MODULES.get(id);
    if (stub) return stub;
    return resolveHyperfideSource(id);
  },
};

const emitDeclarations = sharedDeclarationEmit(
  Object.values(outputs),
  repoRoot,
  inlineWorkspace.resolveId,
);

async function bundle(input) {
  const build = await rollup({
    input: declarationId(input),
    // Core entry points must not import their own public package's types.
    external: [
      ...EXTERNAL,
      ...(["index.ts", "app.ts", "host.ts"].some(
        (name) => input === path.join(pkgRoot, "src", name),
      )
        ? []
        : [/^@hyperfide\/plugin-sdk$/]),
    ],
    plugins: [emitDeclarations, dts({ respectExternal: false })],
    onwarn(warning) {
      // Circular type references are fine in .d.ts output; surface everything
      // else so a genuinely broken bundle is visible.
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      console.warn(`[build-bundled-dts] ${warning.code}: ${warning.message}`);
    },
  });
  try {
    const { output } = await build.generate({ format: "es" });
    return output[0].code;
  } finally {
    await build.close();
  }
}

const HEADER = [
  "// Portable type declarations for `@hyperfide/plugin-sdk`. Unpublished HYPERFIDE",
  "// workspace contracts are flattened; public subpaths may reuse the",
  "// package root without requiring any other @hyperfide/* package.",
  "//",
  "// Confused by the API, or need a symbol that isn't here? Clone the HYPERFIDE repo",
  "// and read the real source: https://github.com/hyperfide/hyperfide",
].join("\n");

function generateBundle(entry) {
  return bundle(entry).then((code) =>
    normalizeBundledDts(`${HEADER}\n\n${code}`),
  );
}

const generated = {};
for (const [name, entry] of Object.entries(outputs)) {
  generated[name] = await generateBundle(entry);
}
writeOutputs(generated);

function writeOutputs(generated) {
  mkdirSync(outDir, { recursive: true });

  for (const [fileName, content] of Object.entries(generated)) {
    const target = path.join(outDir, fileName);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === content) {
      console.log(`Unchanged ${path.relative(pkgRoot, target)}`);
    } else {
      writeAtomically(target, content);
      console.log(`Wrote ${path.relative(pkgRoot, target)}`);
    }
  }
}

/**
 * Temp sibling + rename, so a concurrent reader (another turbo process, tsc
 * in an editor) never sees a truncated declaration file.
 */
function writeAtomically(target, content) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
