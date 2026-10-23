import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir(".bundled-runtime", { recursive: true });
await build({ entryPoints: ["server.ts", "host.ts"], outdir: ".bundled-runtime", bundle: true, format: "esm", platform: "node", external: ["@hyperfide/plugin-sdk", "@hyperfide/plugin-sdk/*"] });
const manifest = JSON.parse(await readFile("package.json", "utf8"));
manifest.hyperfide = { ...manifest.hyperfide, server: "./server.js", host: "./host.js" };
await writeFile(".bundled-runtime/package.json", JSON.stringify(manifest, null, 2));
