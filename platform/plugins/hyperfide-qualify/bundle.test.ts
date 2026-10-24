import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('prepares a server bundle without host SDK subpath imports', async () => {
  await promisify(execFile)(process.execPath, ['prepare.mjs'], {
    cwd: new URL('.', import.meta.url),
  });
  const bundle = await readFile(new URL('.bundled-runtime/server.js', import.meta.url), 'utf8');
  expect(bundle).not.toMatch(/['"]@hyperfide\/plugin-sdk\//);
  expect(bundle).toContain('@hyperfide/plugin-sdk');
});
