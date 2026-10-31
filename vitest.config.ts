import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { SharedWorkerSequencer } from "./vitest.shared.js";

const workspaceRoots = [
  "apps",
  "core",
  "sdk",
  "contracts",
  "lib",
  "tools",
  "tests",
  "examples",
  "examples/plugins",
  "tests/fixtures/plugins",
] as const;
const excludedProjects = new Set(["core/control-plane", "core/kvx"]);

function discoverVitestProjects(): string[] {
  return workspaceRoots
    .filter((workspaceRoot) => existsSync(path.resolve(workspaceRoot)))
    .flatMap((workspaceRoot) =>
      readdirSync(path.resolve(workspaceRoot), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(workspaceRoot, entry.name))
        .filter((projectPath) =>
          !excludedProjects.has(projectPath) &&
          existsSync(path.resolve(projectPath, "vitest.config.ts")),
        ),
    )
    .sort((a, b) => a.localeCompare(b));
}

export default defineConfig({
  test: {
    silent: "passed-only",
    sequence: { sequencer: SharedWorkerSequencer },
    projects: discoverVitestProjects(),
  },
});
