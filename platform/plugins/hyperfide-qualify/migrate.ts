import { resolve } from 'node:path';
import { openQualifyStorage, migrateQualifyArtifacts } from './storage';
if (!process.argv[2]) throw Error('Usage: migrate.ts <repository>');
const repository = resolve(process.argv[2]);
const storage = await openQualifyStorage(repository);
try { console.log(await migrateQualifyArtifacts(repository, storage)); }
finally { storage.close(); }
