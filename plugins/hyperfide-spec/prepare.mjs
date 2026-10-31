import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('.bundled-runtime', { recursive: true });
await build({
  entryPoints: { server: 'src/read-model-server.ts' },
  outdir: '.bundled-runtime', bundle: true, platform: 'node', format: 'esm',
  external: ['@hyperfide/plugin-sdk', '@hyperfide/plugin-sdk/*'],
});
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.hyperfide.server = './server.js';
await writeFile('.bundled-runtime/package.json', JSON.stringify(manifest, null, 2));
