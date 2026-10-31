import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const workspacePackages = new Map();
for (const category of ["apps", "core", "sdk", "contracts", "lib", "tools", "plugins"]) {
  const categoryRoot = path.join(workspaceRoot, category);
  for (const entry of readdirSync(categoryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || (category === "core" && entry.name === "control-plane")) continue;
    const directory = path.join(categoryRoot, entry.name);
    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string") continue;
    workspacePackages.set(manifest.name, { directory, manifest });
  }
}

function resolveWorkspaceSource(id) {
  const match = /^@hyperfide\/([^/]+)(\/.*)?$/u.exec(id);
  if (!match) return null;
  const entryPackage = workspacePackages.get(`@hyperfide/${match[1]}`);
  if (!entryPackage) return null;
  const { directory: packageDirectory, manifest } = entryPackage;
  const key = match[2] ? `.${match[2]}` : ".";
  const entry = manifest.exports?.[key];
  const source =
    typeof entry === "string"
      ? entry
      : (entry?.source ?? entry?.types ?? entry?.default);
  return source ? path.join(packageDirectory, source) : null;
}

const inlineWorkspace = {
  name: "inline-hyperfide-workspace",
  resolveId(id) {
    return resolveWorkspaceSource(id);
  },
};

const build = await rollup({
  input: path.join(packageRoot, "src/public-sdk.ts"),
  external: [/^zod($|\/)/u],
  plugins: [
    inlineWorkspace,
    dts({
      respectExternal: false,
      compilerOptions: {
        baseUrl: workspaceRoot,
        paths: {
          "@hyperfide/hono-typed-routes": ["lib/hono-typed-routes/src/index.ts"],
        },
      },
    }),
  ],
  onwarn(warning) {
    if (warning.code !== "CIRCULAR_DEPENDENCY") {
      console.warn(
        `[build-public-sdk-dts] ${warning.code}: ${warning.message}`,
      );
    }
  },
});
await build.write({
  file: path.join(packageRoot, "dist/index.d.ts"),
  format: "es",
});
await build.close();
