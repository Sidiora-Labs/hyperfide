import assert from 'node:assert/strict';
import { AuthorityStorage, openPluginStorage } from '../src/index.js';
assert.ok(process.env.HYPERFIDE_AUTHORITY_URL);
const storage = await openPluginStorage('hyperfide-spec', 'embedded-smoke');
assert.ok(storage instanceof AuthorityStorage);
if (process.env.HYPERFIDE_AUTHORITY_TEST_RESTART === '1') assert.deepEqual(await storage.get('cache'), { local: true });
else await storage.put('cache', { local: true });
assert.deepEqual(await storage.get('cache'), { local: true });
storage.close();
