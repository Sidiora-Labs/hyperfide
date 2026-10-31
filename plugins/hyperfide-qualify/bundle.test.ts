import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('prepares loader-compatible artifacts without host SDK subpath imports', async () => {
  await promisify(execFile)(process.execPath, ['../../tools/plugin-build/dist/cli.js', 'prepare-bundled'], {
    cwd: new URL('.', import.meta.url),
  });
  const json = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const source = await json('package.json');
  const sdk = await json('../../sdk/plugins/package.json');
  const manifest = await json('.bundled-runtime/package.json');
  expect(manifest.hyperfide.server).toBe('./dist/server.js');
  expect(manifest.hyperfide.app).toBe('./dist/app.js');
  for (const artifact of ['server', 'app']) {
    expect(await readFile(new URL(`.bundled-runtime/dist/${artifact}.js`, import.meta.url), 'utf8')).not.toBe('');
    expect(await json(`.bundled-runtime/dist/${artifact}.meta.json`)).toMatchObject({
      artifactFormatVersion: 1,
      sdkMajor: Number(sdk.version.split('.')[0]),
      sdkVersion: sdk.version,
      pluginId: 'hyperfide-qualify',
      pluginVersion: source.version,
    });
  }
  const bundle = await readFile(new URL('.bundled-runtime/dist/server.js', import.meta.url), 'utf8');
  expect(bundle).not.toMatch(/['"]@hyperfide\/plugin-sdk\//);
  expect(bundle).toContain('@hyperfide/plugin-sdk');
}, 30_000);
