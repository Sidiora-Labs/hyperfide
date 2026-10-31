import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const tablePath = "plugins/plugin-api-docs/src/first-party-plugins.json";

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function manifestRows() {
  const rows = new Map();
  for (const entry of readdirSync(resolve(root, "plugins"), {
    withFileTypes: true,
  })) {
    const path = `plugins/${entry.name}/package.json`;
    if (!entry.isDirectory() || !existsSync(resolve(root, path))) continue;
    const manifest = readJson(path);
    if (manifest.hyperfide === undefined) continue;
    const icon = manifest.hyperfide.branding?.icon ?? null;
    const id = manifest.name.replace(/^hyperfide-plugin-/u, "");
    rows.set(id, {
      id,
      name: manifest.hyperfide.name,
      icon: icon === null || icon.startsWith("./") ? null : icon,
    });
  }
  return rows;
}

describe("Plugin Guide first-party plugins", () => {
  it("matches each listed plugin's manifest", () => {
    const manifests = manifestRows();
    for (const row of readJson(tablePath)) {
      expect(
        row,
        `${tablePath} row for ${row.id} must match plugins/*/package.json (id from the package name, hyperfide.name, and a non-asset hyperfide.branding.icon)`,
      ).toEqual(manifests.get(row.id));
    }
  });
});
