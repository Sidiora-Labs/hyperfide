import { storageContract } from '../../core/authority-client/test/storage-contract';
storageContract('hyperfide-qualify');

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { migrateQualifyArtifacts, openQualifyStorage } from './storage';
test('imports existing receipt artifacts through the selected implementation', async () => {
  const repository = await mkdtemp(join(tmpdir(), 'hyperfide-receipt-migration-'));
  const folder = join(repository, 'artifacts/hyperfide/tasks/6.3/lane');
  const receipt = { task: '6.3', commit: 'a'.repeat(40), exit: 0, evidence: ['verify.log'] };
  const storage = await openQualifyStorage(repository);
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'receipt.json'), JSON.stringify(receipt));
    expect(await migrateQualifyArtifacts(repository, storage)).toBe(1);
    expect(await migrateQualifyArtifacts(repository, storage)).toBe(1);
    expect(await storage.get('receipt:artifacts/hyperfide/tasks/6.3/lane/receipt.json')).toEqual(receipt);
  } finally { storage.close(); await rm(repository, { recursive: true, force: true }); }
});
