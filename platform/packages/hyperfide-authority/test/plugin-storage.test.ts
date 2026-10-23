import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { createAuthorityClient, type AuthorityConfiguration } from '../src/index.js';
const config = (): AuthorityConfiguration => JSON.parse(process.env.HYPERFIDE_AUTHORITY_TEST_CONFIG!);
test('service validates plugin namespaces and scope before touching state', async () => {
  const client = await createAuthorityClient(config());
  await expect(client.pluginState({ plugin: 'unknown' as 'hyperfide-spec', scope: 'test', operation: 'list' })).rejects.toMatchObject({code: 'INVALID_REQUEST'});
  await expect(client.pluginState({ plugin: 'hyperfide-spec', scope: '', operation: 'list' })).rejects.toMatchObject({code: 'INVALID_REQUEST'});
});
test('state mutation reconciles the original signed operation identity', async () => {
  const client = await createAuthorityClient(config());
  const request = { plugin: 'hyperfide-spec' as const, scope: randomUUID(), operation: 'write' as const,
    entries: [{ key: 'cache', value: 1 }], remove: [] };
  const identity = {operationId: randomUUID(), idempotencyKey: randomUUID()};
  await client.pluginState(request, identity);
  await client.pluginState(request, identity);
  await expect(client.pluginState({ ...request, entries: [{key: 'cache', value: 2}] }, identity)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const unlisted = await createAuthorityClient(JSON.parse(process.env.HYPERFIDE_AUTHORITY_TEST_UNLISTED!));
  await expect(unlisted.pluginState(request)).rejects.toMatchObject({code: 'AUTH_SCOPE_DENIED'});
});

test('migration command uploads an existing SQLite store and downloads it intact', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { PrivateStorage } = await import('../src/index.js');
  const root = await mkdtemp(join(tmpdir(), 'hyperfide-migrate-cli-'));
  const scope = randomUUID(), sourcePath = join(root, 'source.sqlite'), targetPath = join(root, 'target.sqlite');
  const source = new PrivateStorage(sourcePath, 'hyperfide-asks', scope);
  // More than one transport batch verifies the migration and listing cursors.
  for (let i = 0; i < 130; i++) await source.put('ask:' + String(i).padStart(3, '0'), { id: i, status: 'open' });
  source.close();
  const c = config();
  const env = { ...process.env, HYPERFIDE_AUTHORITY_URL: c.url, HYPERFIDE_AUTHORITY_CA_FILE: c.caFile,
    HYPERFIDE_AUTHORITY_KEY_FILE: c.keyFile, HYPERFIDE_AUTHORITY_CREDENTIAL_ID: c.credentialId, HYPERFIDE_AUTHORITY_RUN_ID: c.runId };
  const run = (path: string, direction: string) => promisify(execFile)('pnpm', ['-C', 'platform', 'exec', 'tsx',
    'packages/hyperfide-authority/bin/migrate-plugin-state.ts', 'hyperfide-asks', scope, path, direction],
    { cwd: process.env.HYPERFIDE_AUTHORITY_TEST_ROOT!, env });
  try {
    await run(sourcePath, 'upload');
    await run(sourcePath, 'upload');
    await run(targetPath, 'download');
    const target = new PrivateStorage(targetPath, 'hyperfide-asks', scope);
    try {
      expect(await target.entries()).toHaveLength(130);
      expect(await target.get('ask:129')).toEqual({id: 129, status: 'open'});
    } finally { target.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
