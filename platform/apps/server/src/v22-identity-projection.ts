import {
  existsSync,
  readdirSync,
  cpSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const projectedSkillRoots = new Map<string, string>();
export function projectSkillRoot(root: string): string {
  if (!existsSync(root) || existsSync(join(root, "hyperfide-plugin-authoring")))
    return root;
  const oldName = readdirSync(root).find((name) =>
    name.endsWith("-plugin-authoring"),
  );
  if (!oldName) return root;
  const cached = projectedSkillRoots.get(root);
  if (cached) return cached;
  const projected = join(
    mkdtempSync(join(tmpdir(), "hyperfide-skills-")),
    "skills",
  );
  cpSync(root, projected, { recursive: true });
  const canonical = join(projected, "hyperfide-plugin-authoring");
  renameSync(join(projected, oldName), canonical);
  const skill = join(canonical, "SKILL.md");
  writeFileSync(
    skill,
    readFileSync(skill, "utf8").replace(
      /^name: .*plugin-authoring$/m,
      "name: hyperfide-plugin-authoring",
    ),
  );
  projectedSkillRoots.set(root, projected);
  return projected;
}

// Temporary prerequisite adapter: remove when task 0.7's manifest and path migration merges.
export function projectPluginPackageJson(
  input: unknown,
  schemaKeys: readonly string[],
): unknown {
  if (input === null || typeof input !== "object") return input;
  const value = input as Record<string, unknown>;
  const metadataKey = schemaKeys.find(
    (key) => !["name", "version", "engines"].includes(key),
  );
  if (!metadataKey || !(value[metadataKey] ?? value.hyperfide)) return input;
  const candidate = (value[metadataKey] ?? value.hyperfide) as Record<
    string,
    unknown
  >;
  if (
    !value.hyperfide &&
    candidate.id === undefined &&
    candidate.cli === undefined
  )
    return input;
  const metadata = (value[metadataKey] ?? value.hyperfide) as Record<
    string,
    unknown
  >;
  const { id: _id, cli: _cli, ...supported } = metadata;
  return {
    ...value,
    ...(["asks", "graph", "qualify"].some(
      (name) => value.name === `@hyperfide/plugin-${name}`,
    )
      ? { name: String(value.name).replace("@hyperfide/plugin-", "hyperfide-") }
      : ["machine-railway", "machine-blaxel"].some(
            (name) => value.name === `hyperfide-plugin-${name}`,
          )
        ? {
            name: String(value.name).replace("hyperfide-plugin-", "hyperfide-"),
          }
        : {}),
    [metadataKey]: {
      ...supported,
      description: metadata.description ?? value.description ?? metadata.name,
      branding: metadata.branding ?? { icon: "Puzzle" },
    },
  };
}

export function resolveProjectedSkillRoot(canonical: string): string {
  if (existsSync(canonical)) return canonical;
  const parent = dirname(canonical);
  const candidate = readdirSync(parent).find((name) =>
    name.endsWith("-plugin-authoring"),
  );
  if (!candidate) throw new Error(`Missing prerequisite skill: ${canonical}`);
  return join(parent, candidate);
}

// Project the unmerged provider worker module into an independently buildable tree.
// The graph code stays intact; no private workspace package is exposed to plugins.
export async function buildProjectedPluginHost(
  ...args: Parameters<typeof import("@hyperfide/plugin-build").buildPluginHost>
): ReturnType<typeof import("@hyperfide/plugin-build").buildPluginHost> {
  const { buildPluginHost } = await import("@hyperfide/plugin-build");
  const { cp, mkdir, mkdtemp, readFile, symlink } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const [root, version, toolchain] = args;
  const injection = join(root, "src", "worker-injection.ts");
  const graphSource = join(
    dirname(root),
    "hyperfide-graph",
    "src",
    "worker-injection",
  );
  if (
    !existsSync(injection) ||
    !existsSync(graphSource) ||
    !(await readFile(injection, "utf8")).includes(
      "../../hyperfide-graph/src/worker-injection/worker-injection.js",
    )
  ) {
    return buildPluginHost(...args);
  }
  const workspace = await mkdtemp(
    join(tmpdir(), "hyperfide-provider-projection-"),
  );
  const projected = join(workspace, "provider");
  await cp(root, projected, {
    recursive: true,
    filter: (path) =>
      !["dist", "node_modules", ".git"].includes(
        path.slice(path.lastIndexOf("/") + 1),
      ),
  });
  const destination = join(
    workspace,
    "hyperfide-graph",
    "src",
    "worker-injection",
  );
  await mkdir(dirname(destination), { recursive: true });
  await cp(graphSource, destination, { recursive: true });
  if (existsSync(join(root, "node_modules")))
    await symlink(
      join(root, "node_modules"),
      join(projected, "node_modules"),
      "dir",
    );
  return buildPluginHost(projected, version, toolchain);
}

export function projectedInstallerCli(script: string): string {
  const name = script.match(/elif command -v ([\w-]+) >/)?.[1];
  if (!name) throw new Error("Missing installer CLI prerequisite");
  return name;
}
