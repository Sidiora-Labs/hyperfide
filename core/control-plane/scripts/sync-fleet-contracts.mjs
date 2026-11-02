import {copyFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['source', 'dist'].includes(mode)) throw new Error('Expected source or dist');
const source = mode === 'source' ? path.resolve(root, '../../contracts/fleet') : path.join(root, 'src/contracts/fleet');
const target = path.join(root, mode === 'source' ? 'src' : 'dist', 'contracts/fleet');
await mkdir(target, {recursive: true});
for (const name of ['index.mjs', 'index.d.mts']) await copyFile(path.join(source, name), path.join(target, name));

if (mode === 'source') {
  const sourceContracts = path.resolve(root, '../../sdk/source-control/src/contracts.ts');
  const targetContracts = path.join(root, 'src/source_control/contracts.ts');
  await mkdir(path.dirname(targetContracts), {recursive: true});
  await copyFile(sourceContracts, targetContracts);
}
