import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('.bundled-runtime', {recursive: true});
const shared = {outdir: '.bundled-runtime', bundle: true, format: 'esm', external: ['@hyperfide/plugin-sdk', '@hyperfide/plugin-sdk/*']};
await build({...shared, entryPoints: ['server.ts', 'cli.ts'], platform: 'node'});
await build({...shared, entryPoints: ['app.ts'], platform: 'browser'});
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.hyperfide = {...manifest.hyperfide, server: './server.js', app: './app.js'};
await writeFile('.bundled-runtime/package.json', JSON.stringify(manifest, null, 2));
