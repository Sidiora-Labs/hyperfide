import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BUNDLED_PLUGINS } from "../../apps/server/src/services/plugins/builtin-registry.js";

import { HYPERFIDE_BUNDLED_PLUGINS } from "./plugins.js";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(import.meta.dirname, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const { name } of [
  ...BUNDLED_PLUGINS,
  ...HYPERFIDE_BUNDLED_PLUGINS.filter(
    (plugin) =>
      !BUNDLED_PLUGINS.some((existing) => existing.name === plugin.name),
  ),
]) {
  await cp(
    resolve(root, "plugins", name, ".bundled-runtime"),
    resolve(output, name),
    { recursive: true },
  );
}
